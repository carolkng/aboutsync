const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

const React = require("react");
const ReactDOM = require("react-dom");
const DOM = require("react-dom-factories");
const ReactSimpleTabs = require("react-simpletabs");

const { Fetching, ObjectInspector, ErrorDisplay, arrayCloneWithoutJank } = require("./common");
const { TableInspector } = require("./AboutSyncTableInspector");
const { AboutSyncRecordEditor } = require("./AboutSyncRecordEditor");
const { ProviderState } = require("./provider");
const { PlacesSqlView, promiseSql } = require("./PlacesSqlView");

const validation = require("./validation");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FxAccounts.jsm");
Cu.import("resource://services-sync/main.js");
Cu.import("resource://gre/modules/PlacesUtils.jsm");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/resource.js");

class AccountInfo extends React.Component {
  constructor(props) {
    super(props);
    this.state = { user: null, profile: null }
  }

  componentDidMount() {
    fxAccounts.getSignedInUser().then(data => {
      this.setState({ user: data });
      if (data) {
        fxAccounts.getSignedInUserProfile().then(profile => {
          this.setState({ profile });
        });
      }
    }).catch(Cu.reportError);
  }

  render() {
    let user = this.state.user;
    if (!user) {
      return <Fetching label="Fetching account info..."/>;
    }
    return (
      <div>
        <div className="profileContainer">
          <div className="avatarContainer">
            {this.state.profile &&
              <img src={this.state.profile.avatar} className="avatar"/>}
          </div>
          <div className="userInfoContainer">
            {this.state.profile && <p>{this.state.profile.displayName}</p>}
          </div>
        </div>
        {this.state.profile &&
          <ObjectInspector name="Full Profile"
                           data={this.state.profile}
                           expandLevel={0}/>}
        <p>{user.email}</p>
      </div>
    );
  }
}

// takes an array of objects who have no real properties but have a bunch of
// getters on their prototypes, and returns an array of new objects that contain
// the properties directly. Used for XPCOM stuff. prioritizedKeys are keys
// which should be first in iteration order -- which means first in the table
// when displayed.  This probably should be doable by passing in props to
// our TableInspector...
function expandProtoGetters(arr, prioritizedKeys = []) {
  return arr.map(o => {
    let result = Object.assign({}, o);
    delete result.QueryInterface; // probably some other crap that needs to go as well...
    prioritizedKeys.forEach(k => result[k] = o[k]);
    let protoKeys = Object.keys(Object.getPrototypeOf(o));
    for (let key of protoKeys) {
      if (key in result) {
        continue;
      }
      let val = o[key];
      if (val != null && typeof val != "function") {
        result[key] = o[key];
      }
    }
    return result;
  });
}

async function basicBuilder(validator, serverRecords, expandData = false, prioritizedKeys = []) {
  let clientRecords = await validator.getClientItems();
  let validationResults = await validator.compareClientWithServer(clientRecords, serverRecords);

  let serverMap = new Map(validationResults.records.map(item => [item.id, item]));
  let clientMap = new Map(validationResults.clientRecords.map(item => [item.id, item]));

  let fullClientData = clientRecords;
  if (expandData) {
    fullClientData = expandProtoGetters(clientRecords, prioritizedKeys);
    fullClientData.forEach(cr => {
      let normed = clientMap.get(cr.syncGUID);
      if (normed) {
        normed.original = cr;
        cr.normalized = normed;
      }
    });
  }

  return {
    "Validation": (
      <validation.ResultDisplay clientMap={clientMap}
                                serverMap={serverMap}
                                serverRecords={serverRecords}
                                problems={validationResults.problemData}/>
    ),
    "Raw validation results": (
      <ObjectInspector name="Validation" data={validationResults}/>
    ),
    "Client Records": <TableInspector data={fullClientData}/>,
  };
}

// Functions that compute additional per-collection components. Return a
// promise that resolves with an object with key=name, value=react component.
const collectionComponentBuilders = {
  async addons(provider, serverRecords) {
    Cu.import("resource://services-sync/engines/addons.js");
    let validator = new AddonValidator(Weave.Service.engineManager.get("addons"));
    return basicBuilder(validator, serverRecords, true, ["syncGUID", "id"]);
  },

  async clients(provider, serverRecords) {
    let fxaDevices = await fxAccounts.getDeviceList();
    fxaDevices = JSON.parse(JSON.stringify(fxaDevices));
    return {
      "FxA Devices": <ObjectInspector name="Devices" data={fxaDevices}/>
    };
  },

  async passwords(provider, serverRecords) {
    Cu.import("resource://services-sync/engines/passwords.js");
    return basicBuilder(new PasswordValidator(), serverRecords, true, ["guid", "id"]);
  },

  async forms(provider, serverRecords) {
    Cu.import("resource://services-sync/engines/forms.js");
    return basicBuilder(new FormValidator(), serverRecords, false);
  },

  async bookmarks(provider, serverRecords) {
    Cu.import("resource://services-sync/bookmark_validator.js");
    let clientTree = await provider.promiseBookmarksTree();
    let validator = new BookmarkValidator();
    let validationResults = await validator.compareServerWithClient(serverRecords, clientTree);
    let probs = validationResults.problemData;

    // If we're running locally, add syncChangeCounter and syncStatus to the
    // client records so that it shows up in various tables.
    if (ProviderState.useLocalProvider) {
      let rows = await promiseSql("select syncChangeCounter, syncStatus, guid from moz_bookmarks");
      let lookup = new Map(rows.map(row => [row.guid, row]));
      for (let bmark of validationResults.clientRecords) {
        let item = lookup.get(bmark.guid);
        if (!item) {
          continue;
        }
        bmark.syncChangeCounter = item.syncChangeCounter;
        bmark.syncStatus = item.syncStatus;
      }
    }

    // Turn the list of records into a map keyed by ID.
    let serverMap = new Map(serverRecords.map(item => [item.id, item]));
    // Ensure that we show the instance the validator considered canonical
    // (this may be different in the case of duplicate ids).
    validationResults.records.forEach(record => serverMap.set(record.id, record));

    let clientMap = new Map(validationResults.clientRecords.map(item => [item.id, item]));

    // We can't use the tree we generated above as the bookmark validator
    // mutates it.
    let rawTree = await provider.promiseBookmarksTree();

    return {
      "Validation": (
        <validation.ResultDisplay clientMap={clientMap}
                                  serverMap={serverMap}
                                  serverRecords={serverRecords}
                                  problems={validationResults.problemData}
                                  handlers={validation.BookmarkHandlers}/>
      ),
      "Raw validation results": (
        <ObjectInspector name="Validation" data={validationResults}/>
      ),
      "Client Records": <TableInspector data={validationResults.clientRecords}/>,
      "Client Tree": <ObjectInspector name="root" data={rawTree}/>,
      "SQL": <PlacesSqlView/>,
    };
  },
};

// Renders a single collection
class CollectionViewer extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  componentDidCatch(error) {
    console.error("About Sync: Failed to fetch collection", err);
    this.setState({ error });
  }

  componentDidMount() {
    this.fetchCollection().catch(err => {
      console.error("About Sync: Failed to fetch collection", err);
      this.setState({ error: err });
    });
  }

  async fetchCollection() {
    let {response, records} = await this.props.provider.promiseCollection(this.props.info);
    let originalRecords = await arrayCloneWithoutJank(records);
    let additionalBuilder = collectionComponentBuilders[this.props.info.name];
    this.setState({
      response,
      records,
      originalRecords,
      hasAdditional: !!additionalBuilder,
      additional: null
    });
    if (additionalBuilder) {
      let additional = await additionalBuilder(this.props.provider, records);
      this.setState({ additional });
    }
  }

  renderAdditionalTabs() {
    if (!this.state.hasAdditional || !this.state.additional) {
      return [];
    }
    return Object.entries(this.state.additional).map(([title, component], i) => (
      <ReactSimpleTabs.Panel title={title} key={title + "@" + i}>
        {component}
      </ReactSimpleTabs.Panel>
    ));
  }

  renderSummary() {
    let lastModified = new Date(this.props.info.lastModified);
    let numDeleted = this.state.records.filter(r => r && r.deleted).length;
    let numNull = this.state.records.filter(r => !r).length;
    let fetchingAdditional = this.state.hasAdditional && !this.state.additional;
    return (
      <div>
        <p className="collectionSummary">
          {this.state.records.length} records ({numDeleted} deleted)
        </p>
        <p className="collectionSummary">
          {this.props.info.url}, last modified at {lastModified.toString()}
        </p>
        {numNull > 0 && (
          <div className="error-message">
            <p>Collection contains {numNull} null payloads!</p>
          </div>
        )}
        {fetchingAdditional && <Fetching label="Building additional info..."/>}
      </div>
    );
  }

  renderTabs() {
    // Array is required since ReactSimpleTabs is buggy (it assumes a lot of
    // unsafe things about props.children).
    return [
      <ReactSimpleTabs.Panel title="Summary" key="summary">
        {this.renderSummary()}
      </ReactSimpleTabs.Panel>,

      <ReactSimpleTabs.Panel title="Response" key="response">
        <ObjectInspector name="Response" data={this.state.response}/>
      </ReactSimpleTabs.Panel>,

      <ReactSimpleTabs.Panel title="Records (table)" key="records-table">
        <TableInspector data={this.state.records}/>
      </ReactSimpleTabs.Panel>,

      <ReactSimpleTabs.Panel title="Records (object)" key="records-object">
        <ObjectInspector name="Records" data={this.state.records}/>
      </ReactSimpleTabs.Panel>,

      this.props.provider.isLocal && (
        <ReactSimpleTabs.Panel title="Record Editor (server)" key="record-editor">
          <AboutSyncRecordEditor
            engine={Weave.Service.engineManager.get(this.props.info.name)}
            records={this.state.originalRecords}/>
        </ReactSimpleTabs.Panel>
      ),
      ...this.renderAdditionalTabs()
    ];
  }

  render() {
    let body = this.state.records
             ? <ReactSimpleTabs>{this.renderTabs()}</ReactSimpleTabs>
             : <Fetching label="Fetching records..."/>;
    return (
      <div className="collection">
        <div className="collection-header">
          {this.props.info.name}
        </div>
        <ErrorDisplay error={this.state.error}
                      onClose={() => this.setState({error: null})}/>
        {body}
      </div>
    );
  }
}

// Drills into info/collections, grabs sub-collections, and renders them
class CollectionsViewer extends React.Component {
  componentWillReceiveProps(nextProps) {
    if (!this.state || !this.state.info || nextProps.provider != this.props.provider) {
      this.setState({info: null});
      this._updateCollectionInfo(nextProps.provider);
    }
  }

  componentDidMount() {
    this._updateCollectionInfo(this.props.provider);
  }

  _updateCollectionInfo(provider) {
    if (!provider) {
      return;
    }
    provider.promiseCollectionInfo().then(info => {
      this.setState({ info, error: null });
    }).catch(err => {
      console.error("Collection viewer failed", err);
      this.setState({ error: err });
    });
  }

  render() {
    if (this.state && this.state.error) {
      return (
        <ErrorDisplay error={this.state.error} prefix="Failed to load collection: "/>
      );
    }

    if (!this.state || !this.state.info) {
      return <Fetching label="Fetching collection info..."/>;
    }

    let provider = this.props.provider;
    let info = this.state.info;
    return (
      <div>
        <p key="status-msg">Status: {info.status}</p>
        {info.collections.map(collection =>
          <CollectionViewer provider={provider} info={collection} key={collection.name} />)}
      </div>
    );
  }
}

module.exports = {
  AccountInfo,
  CollectionsViewer,
};