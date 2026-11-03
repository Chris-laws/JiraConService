/**
 * Ablauf des Ticketerstellers: Freitext → Entwurf → bearbeitete Vorgabemaske → Prüfung und Jira-Text.
 *
 * Der Entwurf entsteht einmal (KI oder offline). Danach gehören die Felder der Person; jede Prüfung rechnet
 * Stream-Vorschlag, ähnliche Tickets und Prioritätsrat aus dem, was in der Maske steht.
 */

var NEW_EPIC = '__new__';
var SAFETY = ['Standard', 'Kritisch'];
var SCALES = ['Single Country', 'Multi-Country', 'Global'];
// Pflichtfelder der Maske (Feld, Bezeichnung)
var REQUIRED = [['title', 'Titel'], ['role', 'Rolle'], ['goal', 'Ziel'], ['benefit', 'Mehrwert'],
  ['current_state', 'Ausgangssituation'], ['criteria', 'Akzeptanzkriterien'], ['stream', 'Stream']];
var EXAMPLES = [
  ['Mindestbestand', 'Als Disponent möchte ich den Mindestbestand für Aktionsartikel vorübergehend überschreiben, damit die ' +
    'Filiale zum Aktionsstart genug Ware hat. Die Änderung muss nach Aktionsende automatisch zurückgesetzt werden.'],
  ['Zwei Streams', 'Bei Lieferantenwechsel soll die Gebindegröße im Artikelstamm aktualisiert werden. Der Bestellvorschlag ' +
    'soll die neue Gebindegröße bei der Bestellmenge nutzen, damit keine falschen Mengen bestellt werden.'],
  ['Mögliches Duplikat', 'Im Wareneingang sollen Teillieferungen einer Palette erfasst werden können, damit offene Restmengen ' +
    'sichtbar bleiben.']
];

/** Die Vorgabemaske, so wie sie im Formular steht. */
function emptyForm(country, priority) {
  return {
    source_text: '', title: '', role: '', goal: '', benefit: '', criteria: '', background: '', country: country,
    priority: priority || 'Medium', stream: '', epic: '', new_epic: '', current_state: '', target_state: '', affected: '',
    links: '', time_saved: '', safety: SAFETY[0], scale: SCALES[0], reviewed: false, open_questions: [], notice: '', ai: false
  };
}

function formFromDraft(text, draft, cls, priority) {
  var top = cls.suggestions.length ? cls.suggestions[0].stream : null;
  var f = emptyForm(draft.country, priority);
  f.source_text = text;
  f.title = draft.title;
  f.role = draft.role;
  f.goal = draft.goal;
  f.benefit = draft.benefit;
  f.criteria = draft.acceptance_criteria.join('\n');
  f.background = draft.background;
  f.stream = cls.uncertain || !top ? '' : top.id;
  f.epic = cls.epic && !cls.uncertain ? cls.epic.key : '';
  f.current_state = draft.current_state;
  f.target_state = draft.target_state;
  f.affected = draft.affected || (cls.suggestions.length ? cls.suggestions[0].matched_keywords : []).join(', ');
  f.links = draft.links.join('\n');
  f.open_questions = draft.open_questions;
  f.notice = draft.notice;
  f.ai = draft.source === 'gemini';
  return f;
}

function formFromFields(f) {
  var g = function (k) { return f[k] === undefined || f[k] === null ? '' : String(f[k]); };
  var form = emptyForm(g('country'), g('priority'));
  form.source_text = g('source_text');
  ['title', 'role', 'goal', 'benefit', 'background', 'new_epic', 'current_state', 'target_state', 'affected', 'links', 'time_saved']
    .forEach(function (k) { form[k] = g(k).trim(); });
  form.criteria = g('criteria');
  form.stream = g('stream');
  form.epic = g('epic');
  form.safety = SAFETY.indexOf(g('safety')) >= 0 ? g('safety') : SAFETY[0];
  form.scale = SCALES.indexOf(g('scale')) >= 0 ? g('scale') : SCALES[0];
  form.reviewed = g('reviewed') === '1';
  form.open_questions = g('open_questions').split('\n').filter(function (q) { return q.trim(); });
  form.ai = g('ai') === '1';
  return form;
}

/** Bezeichnungen der leeren Pflichtfelder. */
function formMissing(form) {
  return REQUIRED.filter(function (r) { return !String(form[r[0]]).trim(); }).map(function (r) { return r[1]; });
}

function formCriteriaList(form) {
  return form.criteria.split(/\r?\n/).map(function (x) { return x.replace(/^[-* ]+|[-* ]+$/g, '').trim(); }).filter(String);
}

function formToDraft(form, fallbackTitle) {
  return newDraft_({
    title: form.title || fallbackTitle || 'Neue Anforderung', role: form.role, goal: form.goal, benefit: form.benefit,
    acceptance_criteria: formCriteriaList(form), background: form.background, priority: form.priority, country: form.country,
    open_questions: form.open_questions, current_state: form.current_state, target_state: form.target_state,
    affected: form.affected, links: form.links.split(/\r?\n/).map(function (u) { return u.trim(); }).filter(String)
  });
}

function ticketDraft(c, text, country) {
  var d = c.ticketWriter.draft(text, country);
  var cls = c.classifier.classify(text);
  var priority = c.priorityAdvisor.assess(text + ' ' + draftAsText(d), d.priority).recommended;
  return formFromDraft(text, d, cls, priority);
}

/** Bewertet die Maske: Stream-Sicherheit, ähnliche Tickets, Prioritätsrat, Jira-Text, Sperrgrund. */
function ticketCheck(c, form, role, reporter) {
  var edited = formToDraft(form);
  var cls = c.classifier.classify(form.source_text || draftAsText(edited));
  var duplicates = [], dupError = null;
  try {
    duplicates = c.duplicates.check(draftAsText(edited));
  } catch (exc) {
    if (!(exc instanceof SourceUnavailable)) throw exc;
    dupError = exc.message;
  }
  var streams = {};
  activeStreams().forEach(function (s) { streams[s.id] = s; });
  if (!streams[form.stream]) form.stream = '';
  var mayCreate = mayCreateEpic(role);
  var epics = form.stream ? streams[form.stream].epics.map(function (e) { return [e.key, e.key + ' · ' + e.title]; }) : [];
  var epicKeys = epics.map(function (e) { return e[0]; });
  if (epicKeys.indexOf(form.epic) < 0 && !(form.epic === NEW_EPIC && mayCreate)) form.epic = '';
  var streamName = form.stream ? streams[form.stream].name : null;
  var epicRef = form.epic === NEW_EPIC ? (form.new_epic ? 'neu: ' + form.new_epic : null) : (form.epic || null);
  var confidence = {};
  cls.all_scores.forEach(function (s) { confidence[s.stream.id] = pyRound(s.confidence * 100); });
  var result = {
    form: form,
    classification: cls,
    duplicates: duplicates,
    duplicates_error: dupError,
    advice: c.priorityAdvisor.assess(form.source_text + ' ' + draftAsText(edited), form.priority),
    stream_confidence: confidence,
    epic_options: epics,
    may_create_epic: mayCreate,
    markup: toJiraMarkup(edited, streamName, epicRef) + scoring_(form),
    blocked: null,
    created: null
  };
  result.blocked = blocked_(c, form, edited, streamName, cls.multi_stream, reporter, gate_(form, duplicates));
  result.likely_duplicates = duplicates.filter(function (d) { return d.level === 'duplicate'; });
  result.form_missing = formMissing(form);
  result.form_criteria_list = formCriteriaList(form);
  return result;
}

/** Angaben für den Score im Jira-Backlog; der Score selbst entsteht in Jira nach der Aufwandsschätzung. */
function scoring_(form) {
  var saved = form.time_saved ? form.time_saved + ' PT/Jahr' : '(noch offen)';
  return '\nZeitersparnis: ' + saved + '\nProzesssicherheit: ' + form.safety + '\nSkalierung: ' + form.scale;
}

function gate_(form, duplicates) {
  var missing = formMissing(form);
  if (missing.length) return 'Pflichtfelder fehlen: ' + missing.join(', ') + '.';
  if (duplicates.some(function (d) { return d.level === 'duplicate'; }) && !form.reviewed) {
    return 'Mögliches Duplikat: bitte prüfen und „Geprüft, trotzdem einreichen“ ankreuzen.';
  }
  return null;
}

/** Antwort im Chat neben der Maske: was ausgefüllt wurde und was noch fehlt. */
function ticketReply(result) {
  var f = result.form;
  var parts = ['Ich habe die Maske rechts ausgefüllt.'];
  if (result.classification.multi_stream) {
    parts.push('Das betrifft mehrere Streams. Pro Stream braucht es ein eigenes Ticket, der Vorschlag steht unten.');
  } else if (f.stream) {
    parts.push('Stream-Vorschlag mit ' + (result.stream_confidence[f.stream] || 0) + ' % Sicherheit.');
  }
  var missing = formMissing(f);
  if (missing.length) parts.push('Noch offen: ' + missing.join(', ') + '. Schreib mir dazu einfach mehr, oder trag es rechts ein.');
  if (result.likely_duplicates.length) parts.push('Achtung, das gibt es wahrscheinlich schon. Die Treffer stehen rechts unten.');
  else if (result.duplicates.length) parts.push(result.duplicates.length + ' ähnliche Treffer in Jira und Confluence, siehe rechts unten.');
  return parts.join(' ');
}

function payloadOptions_(form, streamName, multi, reporter) {
  return {
    project: SETTINGS.jira.project, reporter: reporter, streamId: form.stream || null, streamName: streamName,
    epicKey: form.epic === NEW_EPIC ? null : (form.epic || null), epicLinkField: SETTINGS.jira.epic_link_field, multiStream: multi
  };
}

function blocked_(c, form, edited, streamName, multi, reporter, gate) {
  try {
    issueFields(edited, payloadOptions_(form, streamName, multi, reporter));
  } catch (exc) {
    if (exc instanceof OneStreamOnly) return exc.message;
    throw exc;
  }
  if (gate) return gate;
  if (!c.jiraWriter.enabled) return 'Diese Fassung liest nur. Text kopieren und in Jira einfügen.';
  return null;
}

/** Legt das Ticket an. Nur erreichbar, wenn das Schreiben freigegeben ist. */
function ticketCreate(c, form, reporter, multi) {
  var edited = formToDraft(form);
  var stream = form.stream ? streamById(form.stream) : null;
  var key = c.jiraWriter.createIssue(issueFields(edited, payloadOptions_(form, stream ? stream.name : null, multi, reporter)));
  bumpCacheVersion_('jira'); // neues Ticket sofort in Listen und Duplikatprüfung
  return key;
}
