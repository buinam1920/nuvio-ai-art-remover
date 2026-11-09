// UI controller. All rendering uses DOM APIs + textContent (never innerHTML with data).

import { createClient, DEFAULT_SERVER, assertSafeServerUrl, ApiError } from './nuvio.js';
import {
  listTiles,
  applyArt,
  buildBackup,
  backupFileName,
  parseBackup,
  checkBackupIdentity,
  buildArtRestore,
  buildFullRestore,
  nonArtDifferences,
  DataError,
} from './collections.js';
import { guardedWrite, pullSnapshot, ConflictError } from './workflow.js';
import { suggest, search, CONFIDENT } from './art.js';
import { checkImage, thumbUrl } from './images.js';

const $ = (id) => document.getElementById(id);

/** Tiny element builder. Strings become text nodes, so server data can never inject markup. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v); // CSSOM, allowed by the CSP (inline style attributes are not)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// ---------- State (memory only) ----------

const state = {
  client: null,
  profile: null,
  base: null, // { collections, updatedAt } as last read from the server
  sessionBackup: null, // the backup object downloaded at the start of this session
  vms: [], // one view model per tile
  busy: false,
  tmdbKey: '',
};

// ---------- Status + dialog ----------

let statusTimer;
function setStatus(msg, kind = '') {
  const el = $('status');
  clearTimeout(statusTimer);
  el.textContent = msg || '';
  el.className = `status ${kind}`;
  if (msg && kind === 'ok') statusTimer = setTimeout(() => setStatus(''), 6000);
}

function errorText(err) {
  if (err instanceof ApiError || err instanceof DataError || err instanceof ConflictError) return err.message;
  return err?.message ? String(err.message) : 'Something went wrong.';
}

/** Modal dialog. Resolves true on OK, false on cancel/Escape. */
function ask({ title, body, ok = 'Continue', okClass = 'primary', cancel = 'Cancel', validate }) {
  const dlg = $('dialog');
  $('dialog-h').textContent = title;
  $('dialog-content').replaceChildren(...[].concat(body));
  const okBtn = $('dialog-ok');
  const cancelBtn = $('dialog-cancel');
  okBtn.textContent = ok;
  okBtn.className = `btn ${okClass}`;
  cancelBtn.textContent = cancel || '';
  cancelBtn.hidden = !cancel;
  return new Promise((resolve) => {
    const finish = (val) => {
      okBtn.onclick = cancelBtn.onclick = dlg.oncancel = null;
      dlg.close();
      resolve(val);
    };
    okBtn.onclick = () => {
      if (validate && !validate()) return;
      finish(true);
    };
    cancelBtn.onclick = () => finish(false);
    dlg.oncancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    dlg.showModal();
    (cancel ? cancelBtn : okBtn).focus();
  });
}

const tell = (title, body) => ask({ title, body, ok: 'OK', cancel: null });

function setBusy(on) {
  state.busy = on;
  document.body.toggleAttribute('aria-busy', on);
  for (const id of ['apply-btn', 'restore-btn', 'login-btn', 'signout', 'undo-btn']) {
    const el = $(id);
    if (el) el.disabled = on || (id === 'apply-btn' && !canApply());
  }
  document.querySelectorAll('#profiles button').forEach((b) => (b.disabled = on));
  if (!on) updateCounts();
}

window.addEventListener('beforeunload', (e) => {
  if (state.busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function show(step) {
  for (const id of ['step-login', 'step-profile', 'step-work']) $(id).hidden = id !== step;
  window.scrollTo({ top: 0 });
}

// ---------- Step 1: sign in ----------

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '…';
  }
}

$('server').addEventListener('input', () => {
  $('sendto-host').textContent = hostOf($('server').value.trim());
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const email = $('email').value.trim();
  const pwInput = $('password');
  if (!email || !pwInput.value) return setStatus('Enter your email and password.', 'bad');

  let server;
  try {
    server = assertSafeServerUrl($('server').value || DEFAULT_SERVER);
  } catch (err) {
    return setStatus(errorText(err), 'bad');
  }

  setBusy(true);
  setStatus('Contacting server…');
  try {
    const client = createClient({ server });
    const { backendHost } = await client.discover();
    // If the password would go anywhere other than the official server, say so explicitly first.
    if (backendHost !== hostOf(DEFAULT_SERVER) || server !== DEFAULT_SERVER) {
      $('sendto-host').textContent = backendHost;
      const ok = await ask({
        title: 'Check where your password goes',
        body: [h('p', {}, 'This server says sign-in happens at ', h('strong', {}, backendHost), '. Your password will be sent there.'), h('p', {}, 'Only continue if you trust that server.')],
        ok: 'Sign in there',
      });
      if (!ok) return setStatus('');
    }
    setStatus('Signing in…');
    await client.login(email, pwInput.value);
    pwInput.value = '';
    state.client = client;
    $('session-who').textContent = client.user?.email || email;
    $('session').hidden = false;
    await showProfiles();
  } catch (err) {
    setStatus(errorText(err), 'bad');
  } finally {
    setBusy(false);
  }
});

$('signout').addEventListener('click', async () => {
  if (state.busy) return;
  await state.client?.logout();
  Object.assign(state, { client: null, profile: null, base: null, sessionBackup: null, vms: [], tmdbKey: '' });
  $('tmdb-key').value = '';
  $('groups').replaceChildren();
  $('session').hidden = true;
  $('backup-ok').checked = false;
  show('step-login');
  setStatus('Signed out. Nothing is kept in this tab.', 'ok');
});

function handleAuthLoss(err) {
  if (err instanceof ApiError && err.status === 401) {
    $('session').hidden = true;
    state.client = null;
    show('step-login');
    setStatus('Your session expired. Please sign in again.', 'bad');
    return true;
  }
  return false;
}

// ---------- Step 2: profile ----------

async function showProfiles() {
  setStatus('Loading profiles…');
  const profiles = await state.client.listProfiles();
  const list = $('profiles');
  list.replaceChildren(
    ...profiles.map((p) =>
      h(
        'li',
        {},
        h(
          'button',
          { type: 'button', onclick: () => openProfile(p) },
          h('span', { class: 'avatar', style: p.color ? { background: p.color } : undefined }, (p.name[0] || '?').toUpperCase()),
          h('span', {}, p.name, h('small', {}, p.id === 1 ? 'Main profile' : `Profile ${p.id}`)),
        ),
      ),
    ),
  );
  setStatus('');
  show('step-profile');
}

function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function openProfile(profile) {
  if (state.busy) return;
  setBusy(true);
  setStatus('Reading collections…');
  try {
    const snap = await pullSnapshot(state.client, profile.id);
    // Backup FIRST, before the user can do anything else.
    const backup = buildBackup({
      server: state.client.server,
      userId: state.client.user?.id,
      profileId: profile.id,
      profileName: profile.name,
      updatedAt: snap.updatedAt,
      collections: snap.collections,
    });
    const name = backupFileName(profile.id);
    downloadJson(name, backup);
    state.profile = profile;
    state.base = snap;
    state.sessionBackup = { name, backup };
    $('backup-name').textContent = name;
    $('backup-ok').checked = false;
    $('work-profile').textContent = profile.name;
    renderWorkspace();
    show('step-work');
    setStatus('Backup downloaded. Finding artwork…', 'ok');
    loadSuggestions();
  } catch (err) {
    if (!handleAuthLoss(err)) setStatus(`Stopped: ${errorText(err)} Nothing was changed.`, 'bad');
  } finally {
    setBusy(false);
  }
}

$('backup-again').addEventListener('click', () => {
  if (state.sessionBackup) downloadJson(state.sessionBackup.name, state.sessionBackup.backup);
});
$('backup-ok').addEventListener('change', () => setBusy(state.busy));

// ---------- Step 3: workspace ----------

function renderWorkspace() {
  const tiles = listTiles(state.base.collections);
  state.vms = tiles.map((t) => ({ t, candidates: [], pick: null, skip: true, status: 'loading', msg: 'Finding artwork…', broken: new Set(), done: false, el: null }));
  const groups = new Map();
  for (const vm of state.vms) {
    if (!groups.has(vm.t.collectionId)) groups.set(vm.t.collectionId, { id: vm.t.collectionId, title: vm.t.collectionTitle, vms: [] });
    groups.get(vm.t.collectionId).vms.push(vm);
  }
  $('groups').replaceChildren(
    ...[...groups.values()].map((g) =>
      h('section', { class: 'group' }, h('h2', {}, h('span', { 'data-collection': g.id }, g.title || 'Untitled'), h('small', {}, `${g.vms.length} tiles`)), h('div', { class: 'grid' }, g.vms.map(renderCard))),
    ),
  );
  if (!state.vms.length) $('groups').append(h('p', { class: 'lede' }, 'This profile has collections but no tiles to fix.'));
  updateCounts();
}

function nowArt(vm) {
  const url = vm.t.art.coverImageUrl;
  const ph = h('div', { class: 'ph' }, vm.t.coverEmoji || '–');
  if (typeof url === 'string' && /^https:\/\//i.test(url)) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(ph), { once: true });
    return img;
  }
  return ph;
}

function renderCard(vm) {
  const stage = h('div', { class: 'stage' });
  const head = h('div', { class: 'tile-head' });
  const pickname = h('p', { class: 'pickname' });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': `Artwork options for ${vm.t.title}` });
  const msg = h('p', { class: 'tile-msg' });
  const skip = h('input', { type: 'checkbox', checked: true });
  skip.addEventListener('change', () => {
    if (!skip.checked && !vm.pick) {
      skip.checked = true;
      vm.msg = 'Pick an image first.';
      return updateCard(vm);
    }
    vm.skip = skip.checked;
    updateCard(vm);
    updateCounts();
  });
  const q = h('input', { type: 'search', placeholder: 'Search a movie or show', 'aria-label': `Search artwork for ${vm.t.title}`, enterkeyhint: 'search' });
  const go = h('button', { type: 'button', class: 'btn ghost small' }, 'Search');
  const runSearch = () => doSearch(vm, q.value);
  go.addEventListener('click', runSearch);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
  head.append(h('div', {}, h('h3', {}, vm.t.title || '(untitled)'), pickname), h('label', { class: 'check' }, skip, 'Skip'));
  const card = h('article', { class: 'tile' }, stage, h('div', { class: 'tile-body' }, head, chips, h('div', { class: 'searchrow' }, q, go), msg));
  vm.el = { card, stage, pickname, chips, msg, skip };
  updateCard(vm);
  return card;
}

function updateCard(vm) {
  const { card, stage, pickname, chips, msg, skip } = vm.el;
  card.classList.toggle('selected', !vm.skip);
  card.classList.toggle('skipped', vm.skip);
  skip.checked = vm.skip;

  const kids = [];
  if (vm.pick) {
    kids.push(h('img', { class: 'next', src: thumbUrl(vm.pick.backdropUrl), srcset: `${thumbUrl(vm.pick.backdropUrl)} 300w, ${vm.pick.backdropUrl} 1280w`, sizes: '(max-width: 560px) 100vw, 360px', alt: `New art: ${vm.pick.name}`, loading: 'lazy', referrerpolicy: 'no-referrer' }));
  } else {
    kids.push(h('div', { class: 'empty' }, vm.status === 'loading' ? 'Finding artwork…' : 'No artwork picked'));
  }
  kids.push(h('div', { class: 'now', title: 'Current art' }, nowArt(vm)));
  if (vm.done) kids.push(h('span', { class: 'badge done' }, 'Saved'));
  else if (vm.pick?.score >= CONFIDENT) kids.push(h('span', { class: 'badge good' }, 'Match'));
  else if (vm.pick) kids.push(h('span', { class: 'badge meh' }, 'Your pick'));
  stage.replaceChildren(...kids);

  pickname.textContent = vm.pick ? vm.pick.name : '';
  chips.replaceChildren(
    ...vm.candidates.slice(0, 8).map((c) => {
      const broken = vm.broken.has(c.imdb);
      const thumb = h('img', { src: thumbUrl(c.backdropUrl), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      const b = h(
        'button',
        { type: 'button', class: `chip${broken ? ' broken' : ''}`, 'aria-pressed': String(vm.pick?.imdb === c.imdb), title: c.name, disabled: broken },
        thumb,
        h('span', {}, c.name),
      );
      thumb.addEventListener('error', () => b.classList.add('noimg'), { once: true });
      b.addEventListener('click', () => choose(vm, c));
      return b;
    }),
  );
  msg.textContent = vm.msg || '';
  msg.className = `tile-msg${/couldn|failed|no image/i.test(vm.msg || '') ? ' bad' : ''}`;
}

function canApply() {
  return !!state.base && $('backup-ok').checked && state.vms.some((vm) => !vm.skip && vm.pick);
}

function updateCounts() {
  const sel = state.vms.filter((vm) => !vm.skip && vm.pick).length;
  const loading = state.vms.filter((vm) => vm.status === 'loading').length;
  $('counts').textContent = `${state.vms.length} tiles · ${sel} selected · ${state.vms.length - sel} skipped${loading ? ` · finding art for ${loading}…` : ''}`;
  const btn = $('apply-btn');
  btn.textContent = sel ? `Apply ${sel} tile${sel === 1 ? '' : 's'}` : 'Apply selected';
  btn.disabled = state.busy || !canApply();
  $('applybar-note').textContent = !$('backup-ok').checked
    ? 'Confirm you have the backup file to enable saving.'
    : "Don't edit collections on another device while saving.";
}

/** Use a candidate only after its backdrop is confirmed to load. */
async function choose(vm, c) {
  vm.msg = 'Checking image…';
  updateCard(vm);
  const ok = await checkImage(c.backdropUrl);
  if (!ok) {
    vm.broken.add(c.imdb);
    vm.msg = `No image available for ${c.name}.`;
    updateCard(vm);
    return false;
  }
  vm.pick = c;
  vm.skip = false;
  vm.done = false;
  vm.msg = '';
  updateCard(vm);
  updateCounts();
  return true;
}

async function loadOne(vm) {
  try {
    vm.candidates = await suggest(vm.t.title, vm.t.catalogSources, { limit: 6, tmdbKey: state.tmdbKey || undefined });
  } catch {
    vm.candidates = [];
  }
  vm.status = 'ready';
  const confident = vm.candidates.filter((c) => c.score >= CONFIDENT);
  for (const c of confident) {
    if (await choose(vm, c)) return;
  }
  vm.msg = vm.candidates.length ? 'Not sure about this one. Tap an image or search.' : 'No match found. Search for a movie or show.';
  updateCard(vm);
  updateCounts();
}

async function loadSuggestions() {
  const queue = [...state.vms];
  const worker = async () => {
    while (queue.length) await loadOne(queue.shift());
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  updateCounts();
  setStatus('');
}

async function doSearch(vm, query) {
  const qs = query.trim();
  if (!qs) return;
  vm.msg = 'Searching…';
  updateCard(vm);
  let results = [];
  try {
    results = await search(qs, { limit: 8, tmdbKey: state.tmdbKey || undefined });
  } catch {
    results = [];
  }
  vm.candidates = results;
  vm.msg = results.length ? 'Tap an image to use it.' : 'Nothing found. Try another title.';
  updateCard(vm);
}

$('select-confident').addEventListener('click', () => {
  for (const vm of state.vms) if (vm.pick) vm.skip = false;
  state.vms.forEach(updateCard);
  updateCounts();
});
$('skip-all').addEventListener('click', () => {
  for (const vm of state.vms) vm.skip = true;
  state.vms.forEach(updateCard);
  updateCounts();
});
$('tmdb-key').addEventListener('change', (e) => {
  state.tmdbKey = e.target.value.trim();
});

// ---------- Apply ----------

function changeList(items, labelFn) {
  const max = 40;
  const ul = h('ul', { class: 'changes' }, items.slice(0, max).map((it) => h('li', {}, ...labelFn(it))));
  return items.length > max ? [ul, h('p', {}, `…and ${items.length - max} more.`)] : [ul];
}

$('apply-btn').addEventListener('click', async () => {
  if (state.busy || !canApply()) return;
  const chosen = state.vms.filter((vm) => !vm.skip && vm.pick);
  const picks = new Map(chosen.map((vm) => [vm.t.key, vm.pick.backdropUrl]));
  const nameByKey = new Map(chosen.map((vm) => [vm.t.key, vm.pick.name]));
  let result;
  try {
    result = applyArt(state.base.collections, picks);
    const problems = nonArtDifferences(state.base.collections, result.collections);
    if (problems.length) throw new DataError(`Internal safety check failed: ${problems[0]}`);
  } catch (err) {
    return setStatus(errorText(err), 'bad');
  }
  if (!result.changes.length) return setStatus('Those tiles already have this art. Nothing to save.', 'ok');

  const ok = await ask({
    title: `Save new art for ${result.changes.length} tile${result.changes.length === 1 ? '' : 's'}?`,
    body: [
      ...changeList(result.changes, (c) => [h('span', {}, `${c.collectionTitle} / ${c.title}`), h('span', {}, nameByKey.get(c.key) || '')]),
      h('p', {}, 'For each tile: cover and hero backdrop set to the new image, AI GIF and title logo removed, shape set to landscape, title shown.'),
      h('p', {}, h('strong', {}, 'Not touched: '), 'collection names and order, tile names, catalogs and sources, and every other tile.'),
      h('p', { class: 'callout warn' }, "Don't change collections on another device until this finishes. The tool checks for changes right before saving, but cannot lock your account."),
    ],
    ok: 'Save to Nuvio',
  });
  if (!ok) return;

  await runWrite(result.collections, `Saved new art for ${result.changes.length} tiles. Open Nuvio to check them.`);
});

async function runWrite(payload, successMsg) {
  setBusy(true);
  try {
    const r = await guardedWrite({ client: state.client, profileId: state.profile.id, base: state.base, payload, onStep: (s) => setStatus(s) });
    state.base = r.snapshot;
    refreshCurrentArt(true);
    $('undo-wrap').hidden = false;
    setStatus(r.status === 'nothing-to-do' ? 'Nothing needed saving.' : `${successMsg}${r.note ? ` (${r.note})` : ''}`, 'ok');
  } catch (err) {
    if (handleAuthLoss(err)) return;
    await reportWriteError(err);
  } finally {
    setBusy(false);
  }
}

async function reportWriteError(err) {
  if (err instanceof ConflictError) {
    const reload = await ask({ title: 'Collections changed elsewhere', body: [h('p', {}, err.message)], ok: 'Reload collections', cancel: 'Close' });
    if (reload) await reloadBase();
    return;
  }
  const outcome = err.outcome;
  const lines = {
    unchanged: 'Nothing was saved. Your collections are as they were.',
    conflict: 'The server now holds something different from what was sent. Your backup file is unaffected. Check Nuvio; if something looks wrong, use "Restore from backup".',
    unknown: 'The tool could not confirm what the server holds now. Check Nuvio. Your backup file is unaffected.',
  };
  await tell('Save did not complete', [h('p', {}, errorText(err)), outcome ? h('p', {}, lines[outcome] || '') : null].filter(Boolean));
  if (outcome === 'conflict' || outcome === 'unknown') await reloadBase();
}

async function reloadBase() {
  setBusy(true);
  try {
    state.base = await pullSnapshot(state.client, state.profile.id);
    refreshCurrentArt(false);
    setStatus('Collections reloaded.', 'ok');
  } catch (err) {
    if (!handleAuthLoss(err)) setStatus(`Could not reload: ${errorText(err)}`, 'bad');
  } finally {
    setBusy(false);
  }
}

/** After a write/reload, update each card's "now" art from the server copy. Tiles that no longer exist are dropped. */
function refreshCurrentArt(markSaved) {
  const fresh = new Map(listTiles(state.base.collections).map((t) => [t.key, t]));
  const known = new Set(state.vms.map((vm) => vm.t.key));
  if ([...fresh.keys()].some((k) => !known.has(k)) || state.vms.some((vm) => !fresh.has(vm.t.key))) {
    renderWorkspace(); // structure changed: rebuild
    loadSuggestions();
    return;
  }
  for (const el of document.querySelectorAll('[data-collection]')) {
    const c = state.base.collections.find((x) => x.id === el.dataset.collection);
    if (c) el.textContent = c.title || 'Untitled';
  }
  for (const vm of state.vms) {
    const t = fresh.get(vm.t.key);
    const saved = markSaved && !vm.skip && vm.pick && t.art.coverImageUrl === vm.pick.backdropUrl;
    vm.t = t;
    if (saved) {
      vm.done = true;
      vm.skip = true;
    }
    updateCard(vm);
  }
  updateCounts();
}

// ---------- Restore ----------

$('restore-btn').addEventListener('click', () => {
  if (state.busy) return;
  $('restore-file').value = '';
  $('restore-file').click();
});

$('restore-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return setStatus('That file is too large to be a collections backup.', 'bad');
  let parsed;
  try {
    parsed = parseBackup(await file.text());
  } catch (err) {
    return tell('Cannot use this file', [h('p', {}, errorText(err))]);
  }
  await startRestore(parsed, file.name);
});

$('undo-btn').addEventListener('click', async () => {
  if (state.busy || !state.sessionBackup) return;
  const parsed = parseBackup(JSON.stringify(state.sessionBackup.backup));
  await startRestore(parsed, 'the backup from the start of this session', { artOnly: true });
});

async function startRestore(parsed, label, { artOnly = false } = {}) {
  const session = { server: state.client.server, userId: state.client.user?.id, profileId: state.profile.id };
  const { errors, warnings } = checkBackupIdentity(parsed.meta, session);
  if (errors.length) return tell('This backup does not match', errors.map((m) => h('p', {}, m)));

  setBusy(true);
  let fresh;
  try {
    setStatus('Reading current collections…');
    fresh = await pullSnapshot(state.client, state.profile.id);
  } catch (err) {
    if (!handleAuthLoss(err)) setStatus(`Stopped: ${errorText(err)} Nothing was changed.`, 'bad');
    return setBusy(false);
  }
  setBusy(false);
  setStatus('');

  const art = buildArtRestore(fresh.collections, parsed.collections);
  const full = buildFullRestore(fresh.collections, parsed.collections);
  const fullLoss = full.removedCollections.length + full.removedTiles.length;

  const radioArt = h('input', { type: 'radio', name: 'restore-mode', value: 'art', checked: true });
  const radioFull = h('input', { type: 'radio', name: 'restore-mode', value: 'full' });
  const body = [
    h('p', {}, 'Restoring from ', h('strong', {}, label), parsed.meta.createdAt ? ` (made ${new Date(parsed.meta.createdAt).toLocaleString()})` : '', '.'),
    ...warnings.map((w) => h('p', { class: 'callout warn' }, w)),
  ];
  if (artOnly) {
    body.push(h('p', {}, `Puts back the original artwork on ${art.changes.length} tile${art.changes.length === 1 ? '' : 's'}. Nothing else changes.`));
  } else {
    body.push(
      h(
        'div',
        { class: 'radios' },
        h('label', {}, radioArt, h('span', {}, h('strong', {}, 'Artwork only (recommended)'), h('br'), `Puts back the backup's artwork on ${art.changes.length} tile${art.changes.length === 1 ? '' : 's'}. Collections, tiles and settings you changed since the backup are kept.${art.notInCurrent.length ? ` ${art.notInCurrent.length} tile(s) in the backup no longer exist and are skipped.` : ''}`)),
        h(
          'label',
          {},
          radioFull,
          h(
            'span',
            {},
            h('strong', {}, 'Replace everything'),
            h('br'),
            full.identical
              ? 'Your collections already match this backup exactly.'
              : `Makes this profile's collections exactly match the backup.${fullLoss ? ` This deletes ${full.removedCollections.length} collection(s) and ${full.removedTiles.length} tile(s) added since the backup.` : ''}${full.addedCollections.length ? ` Brings back ${full.addedCollections.length} collection(s).` : ''}`,
          ),
        ),
      ),
    );
    if (fullLoss) {
      body.push(h('details', {}, h('summary', {}, 'What "Replace everything" would delete'), ...changeList([...full.removedCollections.map((n) => `Collection: ${n}`), ...full.removedTiles.map((n) => `Tile: ${n}`)], (s) => [h('span', {}, s)])));
    }
  }
  body.push(h('p', { class: 'callout warn' }, "Don't change collections on another device until this finishes."));

  const ok = await ask({ title: 'Restore from backup?', body, ok: 'Restore' });
  if (!ok) return;
  const mode = artOnly || radioArt.checked ? 'art' : 'full';
  if (mode === 'art' && !art.changes.length) return setStatus('The artwork already matches the backup. Nothing to restore.', 'ok');
  if (mode === 'full' && full.identical) return setStatus('Collections already match the backup.', 'ok');
  if (mode === 'full' && fullLoss) {
    const sure = await ask({
      title: 'Delete newer collections?',
      body: [h('p', { class: 'callout bad' }, `Replacing everything deletes ${full.removedCollections.length} collection(s) and ${full.removedTiles.length} tile(s) that are not in the backup. This cannot be undone unless you have another backup.`)],
      ok: 'Replace everything',
      okClass: 'danger',
    });
    if (!sure) return;
  }
  state.base = fresh;
  await runWrite(mode === 'art' ? art.collections : full.collections, mode === 'art' ? `Restored artwork on ${art.changes.length} tiles.` : 'Collections restored from backup.');
  for (const vm of state.vms) vm.done = false;
  state.vms.forEach((vm) => vm.el && updateCard(vm));
}

// ---------- Init ----------

$('sendto-host').textContent = hostOf($('server').value || DEFAULT_SERVER);
show('step-login');
