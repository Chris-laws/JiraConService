/**
 * Verdrahtet Adapter und Services anhand der Einstellungen. Einziger Ort mit der Weiche mock/live.
 * Teure Teile (Suchindex, Stream-Profile) entstehen erst, wenn eine Seite sie braucht.
 */

function buildContainer(settings) {
  var s = settings || loadSettings();
  var c = { settings: s, notices: [] };

  if (s.dataSource === 'live') {
    c.jira = new CachedJira(new JiraRestReader(s));
    c.jiraWriter = new ReadOnlyJiraWriter();
    c.confluence = new CachedConfluence(new ConfluenceRest(s));
    c.servicenow = new CachedServiceNow(new ServiceNowRest(s));
    c.documents = s.docsFolderId ? new CachedDocuments(new DriveDocuments(s.docsFolderId)) : new EmptyDocuments();
  } else {
    c.jira = new MockJira();
    c.jiraWriter = new ReadOnlyJiraWriter();
    c.confluence = new MockConfluence();
    c.servicenow = new MockServiceNow();
    c.documents = s.docsFolderId ? new DriveDocuments(s.docsFolderId) : new MockDocuments();
  }
  c.changes = c.servicenow;

  c.llm = s.vertexProjectId ? new VertexLlm(s.vertexProjectId, s.vertexLocation, s.geminiModel, s.llmDailyLimit) : new OfflineLlm();
  c.embedder = s.embeddings === 'vertex'
    ? new FallbackEmbedder(new VertexEmbedder(s.vertexProjectId, s.vertexLocation, s.vertexEmbeddingModel), c.notices)
    : new HashingEmbedder();

  var memo = {};
  function lazy(name, make) {
    Object.defineProperty(c, name, { get: function () { if (!(name in memo)) memo[name] = make(); return memo[name]; } });
  }
  lazy('thresholds', function () { return thresholdsFor(c.embedder.name); });
  lazy('index', function () { return buildKnowledgeIndex(c.jira, c.confluence, c.embedder, c.documents); });
  lazy('ticketWriter', function () { return new TicketWriter(c.llm); });
  lazy('priorityAdvisor', function () { return new PriorityAdvisor(); });
  lazy('classifier', function () { return new StreamClassifier(c.embedder, c.thresholds); });
  lazy('duplicates', function () { return new DuplicateChecker(c.index, c.thresholds); });
  lazy('knowledge', function () { return new KnowledgeService(c.index, c.llm, c.thresholds); });
  lazy('myTickets', function () { return new MyTickets(c.jira); });
  lazy('rca', function () { return new RootCauseAnalyzer(c.changes, c.embedder); });
  return c;
}

/**
 * Vertex-Embeddings mit Rückfall: Ist Vertex nicht erreichbar (z. B. Rolle fehlt), rechnet der Offline-Embedder
 * und oben auf der Seite steht ein Hinweis. Innerhalb eines Aufrufs bleibt es bei einem Embedder, damit
 * die Vektoren zueinander passen.
 */
function FallbackEmbedder(primary, notices) {
  this.primary = primary;
  this.fallback = new HashingEmbedder();
  this.notices = notices;
  this.failed = false;
  this.name = primary.name;
  try {
    primary.embed(['Verbindungstest']);
  } catch (exc) {
    if (!(exc instanceof LlmUnavailable)) throw exc;
    this.useFallback_(exc);
  }
}
FallbackEmbedder.prototype.useFallback_ = function (exc) {
  this.failed = true;
  this.name = this.fallback.name;
  this.notices.push('Vertex Embeddings nicht erreichbar (' + exc.message + '). Ähnlichkeiten werden offline berechnet.');
};
FallbackEmbedder.prototype.embed = function (texts) {
  return (this.failed ? this.fallback : this.primary).embed(texts);
};
