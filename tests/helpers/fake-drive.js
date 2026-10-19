// In-memory stand-in for the parts of the Google Drive v3 API the extension uses.
// Automated tests only: nothing here talks to Google.
export class FakeDrive {
  constructor() {
    this.files = new Map();
    this.seq = 0;
    this.token = 'tok-1';
    this.user = { emailAddress: 'me@example.com', displayName: 'Me' };
    this.failures = [];          // [{ match: RegExp, times, kind: 'network' | status number, body? }]
    this.hooks = {};             // onMeta(file), beforeUpdate(file), afterDownload(file)
    this.calls = [];
    this.addFolder('My Drive', null, 'ROOT');
  }

  addFolder(name, parent = 'ROOT', id = `folder-${++this.seq}`) {
    this.files.set(id, { id, name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : [], trashed: false, version: 1, content: null, createdTime: this.seq });
    return id;
  }
  addFile(folderId, name, content) {
    const id = `file-${++this.seq}`;
    this.files.set(id, { id, name, mimeType: 'application/json', parents: [folderId], trashed: false, version: 1, content, createdTime: this.seq });
    return id;
  }
  put(id, content) { const f = this.files.get(id); f.content = content; f.version++; }
  find(folderId, name) { return [...this.files.values()].find((f) => f.parents.includes(folderId) && f.name === name && !f.trashed); }
  fail(match, kind, times = 1, body) { this.failures.push({ match, kind, times, body }); }

  fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = u.pathname;
    this.calls.push(`${method} ${path}${u.search}`);
    const auth = init.headers?.Authorization ?? init.headers?.authorization;
    if (auth !== `Bearer ${this.token}`) return this.json(401, { error: { message: 'Invalid Credentials' } });
    const idx = this.failures.findIndex((f) => f.match.test(`${method} ${path}`) && f.times > 0);
    if (idx >= 0) {
      const f = this.failures[idx];
      f.times--;
      if (f.kind === 'network') throw new TypeError('Failed to fetch');
      return this.json(f.kind, f.body ?? { error: { message: 'injected' } });
    }
    const id = decodeURIComponent(path.split('/').pop());
    if (path === '/drive/v3/about') return this.json(200, { user: this.user });
    if (path === '/drive/v3/files' && method === 'GET') return this.list(u);
    if (path === '/drive/v3/files' && method === 'POST') {
      const b = JSON.parse(init.body);
      const nid = this.addFolder(b.name, b.parents[0]);
      return this.json(200, { id: nid, name: b.name });
    }
    if (path === '/upload/drive/v3/files' && method === 'POST') {
      const [, metaPart, , contentPart] = this.multipart(init.body);
      const nid = this.addFile(metaPart.parents[0], metaPart.name, contentPart);
      return this.json(200, { id: nid, name: metaPart.name, version: '1' });
    }
    if (path.startsWith('/upload/drive/v3/files/') && method === 'PATCH') {
      const f = this.files.get(id);
      if (!f) return this.json(404, { error: { message: 'not found' } });
      this.hooks.beforeUpdate?.(f);
      f.content = init.body; f.version++;
      this.hooks.afterUpdate?.(f);
      return this.json(200, { id, name: f.name, version: String(f.version) });
    }
    if (path.startsWith('/drive/v3/files/') && method === 'GET') {
      const f = this.files.get(id);
      if (!f) return this.json(404, { error: { message: 'File not found' } });
      if (u.searchParams.get('alt') === 'media') {
        const text = f.content;
        this.hooks.afterDownload?.(f);
        return new Response(text, { status: 200 });
      }
      this.hooks.onMeta?.(f);
      return this.json(200, this.meta(f));
    }
    return this.json(400, { error: { message: `unhandled ${method} ${path}` } });
  };

  multipart(body) {
    const parts = body.split(/--il[a-z0-9]+(?:--)?/).map((p) => p.trim()).filter(Boolean);
    const strip = (p) => p.replace(/^Content-Type:[^\r\n]*\r?\n\r?\n/i, '');
    return [null, JSON.parse(strip(parts[0])), null, strip(parts[1])];
  }
  meta(f) { return { id: f.id, name: f.name, mimeType: f.mimeType, trashed: f.trashed, parents: f.parents, version: String(f.version), createdTime: String(f.createdTime), capabilities: { canAddChildren: true } }; }
  list(u) {
    const q = u.searchParams.get('q') ?? '';
    const conds = q.split(' and ');
    let out = [...this.files.values()];
    for (const c of conds) {
      let m;
      if ((m = c.match(/^'(.*)' in parents$/))) out = out.filter((f) => f.parents.includes(m[1].replace(/\\'/g, "'")));
      else if ((m = c.match(/^name='(.*)'$/))) out = out.filter((f) => f.name === m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
      else if ((m = c.match(/^mimeType='(.*)'$/))) out = out.filter((f) => f.mimeType === m[1]);
      else if ((m = c.match(/^mimeType!='(.*)'$/))) out = out.filter((f) => f.mimeType !== m[1]);
      else if (c === 'trashed=false') out = out.filter((f) => !f.trashed);
    }
    out.sort((a, b) => a.createdTime - b.createdTime);
    return this.json(200, { files: out.map((f) => this.meta(f)) });
  }
  json(status, body) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
}
