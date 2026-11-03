/**
 * Einstellungen.
 *
 * - Fachliche Regeln (früher config/settings.yaml) und Streams (früher config/streams.yaml) stehen hier als
 *   JavaScript-Objekte. Neue Streams = neuer Eintrag in STREAMS, kein weiterer Code.
 * - Alles Geheime (PATs, Token) und alles, was je Umgebung anders ist, steht in den Script Properties
 *   (Projekteinstellungen → Skripteigenschaften). Nie im Code.
 */

var SETTINGS = {
  priorities: ['Blocker', 'High', 'Medium', 'Low'],
  default_priority: 'Medium',

  // Rollen: INT (zentrale Koordination) und Land. Nur Rollen in epic_create_roles dürfen neue Epics vorschlagen.
  roles: ['INT', 'Land'],
  default_role: 'Land',
  epic_create_roles: ['INT'],
  // Zuordnung E-Mail → Rolle. Live kommt die E-Mail aus der Google-Anmeldung. Ergänzbar über die
  // Script Property USER_ROLES (JSON, z. B. {"vorname.nachname@firma.de": "INT"}).
  user_roles: {
    'anna.berger@example.com': 'INT',
    'marco.rossi@example.com': 'Land'
  },

  // Ziel beim Anlegen in Jira. Das Epic-Link-Feld ist je Jira-Instanz ein anderes customfield.
  jira: { project: 'ADF', epic_link_field: 'customfield_10008' },

  // Ticket-Lebenszyklus (Reihenfolge = Phase)
  lifecycle: [
    'NEW REQUIREMENT', 'VALIDATION INT', 'ON HOLD DM', 'VALIDATION TEAM', 'ON HOLD',
    'DEVELOPMENT BACKLOG', 'SELECTED FOR DEVELOPMENT', 'READY FOR DEPLOYMENT', 'DONE', 'REJECTED'
  ],

  // Schwellwerte je Embedder (Kosinus-Ähnlichkeit). Vertex-Embeddings liegen höher als der Offline-Embedder.
  thresholds: {
    'default': { duplicate: 0.85, similar: 0.70, multi_stream_ratio: 0.85, multi_stream_min: 0.60, stream_temperature: 0.05 },
    hashing: { duplicate: 0.55, similar: 0.25, multi_stream_ratio: 0.80, multi_stream_min: 0.12, stream_temperature: 0.03 }
  },

  countries: ['DE', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE',
    'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK']
};

// Streams für die Ticket-Zuordnung. PLATZHALTER-Namen und Epics, bis die echten vorliegen.
var STREAMS = [
  {
    id: 'disposition',
    name: 'Disposition & Bestellung',
    description: 'Automatische Bestellvorschläge, Dispositionsparameter, Bestandsführung in der Filiale und im Lager, ' +
      'Mindestbestände, Prognosen für den Absatz.',
    keywords: ['Bestellvorschlag', 'Disposition', 'Bestand', 'Mindestbestand', 'Prognose', 'Absatz', 'Nachschub', 'Bestellung'],
    board: '',
    enabled: true,
    epics: [
      { key: 'ADF-100', title: 'Bestellvorschläge und Prognose' },
      { key: 'ADF-101', title: 'Bestandsführung und Mindestbestände' }
    ]
  },
  {
    id: 'logistik',
    name: 'Logistik & Warenfluss',
    description: 'Warenfluss zwischen Lager und Filiale, Touren, Anlieferung, Wareneingang, Retouren, Abschriften und Warenverlust.',
    keywords: ['Lager', 'Anlieferung', 'Wareneingang', 'Tour', 'Retoure', 'Abschrift', 'Warenverlust', 'LKW', 'Palette'],
    board: '',
    enabled: true,
    epics: [
      { key: 'ADF-200', title: 'Wareneingang und Anlieferung' },
      { key: 'ADF-201', title: 'Retouren und Abschriften' }
    ]
  },
  {
    id: 'stammdaten',
    name: 'Stammdaten',
    description: 'Artikelstammdaten, Lieferantenstammdaten, Filialstammdaten, Sortimentszuordnung, Gebinde und Einheiten.',
    keywords: ['Stammdaten', 'Artikel', 'Lieferant', 'Sortiment', 'Gebinde', 'Einheit', 'Filialstamm', 'EAN'],
    board: '',
    enabled: true,
    epics: [
      { key: 'ADF-300', title: 'Artikel- und Sortimentsstammdaten' },
      { key: 'ADF-301', title: 'Lieferanten- und Filialstammdaten' }
    ]
  },
  {
    id: 'reporting',
    name: 'Reporting & Analyse',
    description: 'Berichte, Kennzahlen, Dashboards und Auswertungen für Länder und Zentrale, Export von Daten, Performance-Übersichten.',
    keywords: ['Bericht', 'Report', 'Kennzahl', 'KPI', 'Dashboard', 'Auswertung', 'Export', 'Übersicht'],
    board: '',
    enabled: true,
    epics: [
      { key: 'ADF-400', title: 'Länderberichte und Kennzahlen' },
      { key: 'ADF-401', title: 'Datenexporte' }
    ]
  }
];

/**
 * Alle Script Properties mit Bedeutung. setup() legt fehlende mit diesem Wert an.
 * Werte, die mit PLATZHALTER beginnen, gelten als nicht gesetzt.
 */
var PROPERTY_DEFAULTS = {
  APP_NAME: 'ReqAlign',
  DATA_SOURCE: 'live',                 // live = echte Daten aus Jira/Confluence/ServiceNow (nur lesend)
  VERTEX_PROJECT_ID: 'PLATZHALTER-gcp-projekt-id',
  VERTEX_LOCATION: 'global',
  GEMINI_MODEL: 'gemini-2.5-flash',
  VERTEX_EMBEDDING_MODEL: 'text-multilingual-embedding-002',
  EMBEDDINGS: 'auto',                  // auto = Vertex, wenn eine Projekt-ID gesetzt ist, sonst offline
  JIRA_URL: 'PLATZHALTER-https://jira.example.com',
  JIRA_PAT: 'PLATZHALTER-jira-pat',
  JIRA_JQL: 'project = ADF ORDER BY updated DESC',
  JIRA_BOARD_DISPOSITION: '',
  JIRA_BOARD_LOGISTIK: '',
  JIRA_BOARD_STAMMDATEN: '',
  JIRA_BOARD_REPORTING: '',
  JIRA_BOARD_ADFCR: '',
  JIRA_ADFCR_JQL: 'project = ADFCR ORDER BY updated DESC',
  CONFLUENCE_URL: 'PLATZHALTER-https://confluence.example.com',
  CONFLUENCE_PAT: 'PLATZHALTER-confluence-pat',
  CONFLUENCE_SPACES: 'ADF',
  SERVICENOW_URL: 'PLATZHALTER-https://servicenow.example.com',
  SERVICENOW_TOKEN: 'PLATZHALTER-servicenow-token',
  DOCS_FOLDER_ID: '',                  // optional: Drive-Ordner mit Markdown-Dateien (Anleitungen, Change Log)
  USER_ROLES: '',                      // optional: JSON {"mail@firma.de": "INT"}
  CACHE_MINUTES: '',                   // leer = 30 Minuten (mit BigQuery 6 Stunden); sonst 1 bis 360
  BQ_DATASET: '',                      // optional: eigener BigQuery-Datensatz (z. B. reqalign); schaltet den Abgleich ein
  BQ_PROJECT: '',                      // leer = VERTEX_PROJECT_ID
  BQ_LOCATION: 'EU',
  CONFLUENCE_EXPORT_FOLDER_ID: ''      // optional: Drive-Ordner mit dem Confluence-Export (ZIP, HTML oder Word)
};

/** Einmal im Editor ausführen: legt alle Script Properties mit Platzhaltern an (vorhandene bleiben). */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperties();
  var added = [];
  Object.keys(PROPERTY_DEFAULTS).forEach(function (key) {
    if (!(key in current)) {
      props.setProperty(key, PROPERTY_DEFAULTS[key]);
      added.push(key);
    }
  });
  Logger.log(added.length ? 'Angelegt: ' + added.join(', ') : 'Alle Script Properties waren schon da.');
}

function ConfigError(message) { this.name = 'ConfigError'; this.message = message; }
ConfigError.prototype = Object.create(Error.prototype);

/**
 * Grundadresse aus dem, was man im Browser kopiert: „https://jira.firma/secure/RapidBoard.jspa?rapidView=1“ wird
 * zu „https://jira.firma“, „https://wiki.firma/spaces/ABC/overview“ zu „https://wiki.firma“. Ein Kontextpfad
 * (z. B. /jira oder /wiki) bleibt erhalten.
 */
function baseUrl_(raw) {
  if (!raw) return raw;
  var url = String(raw).trim().replace(/[?#].*$/, '');
  var cut = url.search(/\/(secure|browse|projects|issues|spaces|display|pages|plugins|dashboard\.action|rest)(\/|$|\.)/i);
  if (cut > url.indexOf('//') + 1) url = url.slice(0, cut);
  return url.replace(/\/+$/, '');
}

function prop_(props, key) {
  var value = String(props[key] === undefined ? '' : props[key]).trim();
  if (!value || /^PLATZHALTER/i.test(value)) return null;
  return value;
}

function boardId_(props, key) {
  var raw = prop_(props, key);
  if (!raw) return null;
  var value = parseInt(raw, 10);
  if (!(value >= 1) || String(value) !== raw) {
    throw new ConfigError(key + ' braucht eine positive numerische Jira-Board-ID');
  }
  return value;
}

/** Liest die Einstellungen. props ist für Tests überschreibbar. */
function loadSettings(props) {
  props = props || PropertiesService.getScriptProperties().getProperties();
  var dataSource = String(props.DATA_SOURCE || 'live').trim().toLowerCase();
  if (dataSource !== 'mock' && dataSource !== 'live') throw new ConfigError('DATA_SOURCE muss live sein');
  if (dataSource === 'mock' && typeof MOCK_DATA === 'undefined') {
    throw new ConfigError('Testdaten sind in dieser Fassung nicht enthalten. DATA_SOURCE auf live setzen oder löschen.');
  }

  var streamBoards = {};
  ['disposition', 'logistik', 'stammdaten', 'reporting'].forEach(function (s) {
    var id = boardId_(props, 'JIRA_BOARD_' + s.toUpperCase());
    if (id !== null) streamBoards[s] = id;
  });
  var nBoards = Object.keys(streamBoards).length;
  if (nBoards && nBoards !== 4) {
    throw new ConfigError('Für eine präzise Board-Abfrage müssen alle vier JIRA_BOARD_<STREAM>-IDs gesetzt sein');
  }
  var project = prop_(props, 'VERTEX_PROJECT_ID');
  var embeddings = String(props.EMBEDDINGS || 'auto').trim().toLowerCase();
  if (embeddings === 'auto') embeddings = project ? 'vertex' : 'hashing';
  if (embeddings === 'vertex' && !project) throw new ConfigError('EMBEDDINGS=vertex braucht VERTEX_PROJECT_ID');

  var userRoles = {};
  Object.keys(SETTINGS.user_roles).forEach(function (k) { userRoles[k.toLowerCase()] = SETTINGS.user_roles[k]; });
  var extra = prop_(props, 'USER_ROLES');
  if (extra) {
    try {
      var parsed = JSON.parse(extra);
      Object.keys(parsed).forEach(function (k) { userRoles[k.toLowerCase()] = String(parsed[k]); });
    } catch (e) {
      throw new ConfigError('USER_ROLES ist kein gültiges JSON');
    }
  }

  return {
    appName: prop_(props, 'APP_NAME') || 'ReqAlign',
    dataSource: dataSource,
    vertexProjectId: project,
    vertexLocation: prop_(props, 'VERTEX_LOCATION') || 'global',
    geminiModel: prop_(props, 'GEMINI_MODEL') || 'gemini-2.5-flash',
    llmDailyLimit: Math.max(0, parseInt(prop_(props, 'LLM_DAILY_LIMIT') || '200', 10) || 0),
    vertexEmbeddingModel: prop_(props, 'VERTEX_EMBEDDING_MODEL') || 'text-multilingual-embedding-002',
    embeddings: embeddings,
    jiraUrl: baseUrl_(prop_(props, 'JIRA_URL')),
    jiraPat: prop_(props, 'JIRA_PAT'),
    jiraJql: prop_(props, 'JIRA_JQL') || 'project = ADF ORDER BY updated DESC',
    jiraBoardIds: streamBoards,
    jiraAdfcrBoardId: boardId_(props, 'JIRA_BOARD_ADFCR'),
    jiraAdfcrJql: prop_(props, 'JIRA_ADFCR_JQL') || 'project = ADFCR ORDER BY updated DESC',
    confluenceUrl: baseUrl_(prop_(props, 'CONFLUENCE_URL')),
    confluencePat: prop_(props, 'CONFLUENCE_PAT'),
    confluenceClientless: /^[123]$/.test(prop_(props, 'CONFLUENCE_CLIENTLESS') || '') ? prop_(props, 'CONFLUENCE_CLIENTLESS') : null,
    confluenceSpaces: (prop_(props, 'CONFLUENCE_SPACES') || '').split(',').map(function (s) { return s.trim(); }).filter(String),
    servicenowUrl: baseUrl_(prop_(props, 'SERVICENOW_URL')),
    servicenowToken: prop_(props, 'SERVICENOW_TOKEN'),
    docsFolderId: prop_(props, 'DOCS_FOLDER_ID'),
    bqDataset: prop_(props, 'BQ_DATASET'),
    bqProject: prop_(props, 'BQ_PROJECT') || project,
    bqLocation: prop_(props, 'BQ_LOCATION') || 'EU',
    confluenceExportFolderId: prop_(props, 'CONFLUENCE_EXPORT_FOLDER_ID'),
    userRoles: userRoles
  };
}

/** Rolle einer Person laut Konfiguration, sonst die Standardrolle. */
function roleFor(settings, email) {
  return settings.userRoles[String(email || '').toLowerCase()] || SETTINGS.default_role;
}

function mayCreateEpic(role) { return SETTINGS.epic_create_roles.indexOf(role) >= 0; }

function thresholdsFor(embedderName) {
  return SETTINGS.thresholds[embedderName] || SETTINGS.thresholds['default'];
}

function activeStreams() { return STREAMS.filter(function (s) { return s.enabled !== false; }); }

function streamById(id) {
  for (var i = 0; i < STREAMS.length; i++) if (STREAMS[i].id === id) return STREAMS[i];
  throw new ConfigError('Unbekannter Stream: ' + id);
}

function streamProfileText(stream) {
  var parts = [stream.name, stream.description, (stream.keywords || []).join(' ')];
  (stream.epics || []).forEach(function (e) { parts.push(e.title); });
  return parts.join(' ');
}
