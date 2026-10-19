import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename, lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { reaEnvironment } from './rea.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVIDENCE = 8 * 1024 * 1024;
const NATIVE_MS = 15 * 60 * 1000;
const SELECTED_SDK_CL = 513885;
const FILES = [
  ['game-dll', 'FactoryGame/Binaries/Win64/FactoryGameSteam-FactoryGame-Win64-Shipping.dll'],
  ['launcher', 'FactoryGameSteam.exe'],
  ['copilot-mod', 'FactoryGame/Mods/AIFactoryCopilot/Binaries/Win64/FactoryGameSteam-AIFactoryCopilot-Win64-Shipping.dll'],
];
const VERSION_FILES = ['FactoryGame/Build/FactoryGame.version', 'Engine/Binaries/Win64/FactoryGameSteam-Win64-Shipping.version'];
const MODULES_FILE = 'FactoryGame/Binaries/Win64/FactoryGameSteam-Win64-Shipping.modules';
const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (code, message) => Object.assign(new Error(message), { code });
const errorData = error => ({ code: String(error?.code ?? error?.name ?? 'REA_FAILED'), message: String(error?.message ?? error),
  ...(error?.details ? { details: error.details } : {}), outcome: 'unknown' });
const checkAbort = signal => { if (signal?.aborted) throw fail('RE_CANCELLED', 'Investigation cancelled; any external outcome remains unknown and was not replayed.'); };

async function fingerprint(path, signal) {
  checkAbort(signal);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw fail('RE_UNSAFE_ARTIFACT', 'Only regular, unlinked artifact files may be inspected');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  const after = await lstat(path);
  if (['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].some(key => before[key] !== after[key])) throw fail('RE_ARTIFACT_CHANGED', 'Artifact changed while its fingerprint was read');
  return { path, bytes: before.size, sha256: hash.digest('hex'), modifiedAt: before.mtime.toISOString() };
}

async function openInstalledRea({ root, signal }) {
  const sdk = name => import(pathToFileURL(join(root, 'tools/rea/node_modules/@modelcontextprotocol/client/dist', name)).href);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('index.mjs'), sdk('stdio.mjs')]);
  const environment = await reaEnvironment();
  // reaEnvironment excludes inherited API credentials and NODE_OPTIONS. The SDK
  // transport and the project wrapper both enforce hidden Windows child launches.
  // Keep the installed provider's supported default 2G heap; do not invent flags.
  const client = new Client({ name: 'copilot-game-investigation', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'scripts/rea.mjs')],
    cwd: root, env: environment, stderr: 'ignore', maxBufferSize: 10 * 1024 * 1024 });
  try { await client.connect(transport, { signal, timeout: 120000 }); }
  catch (error) { try { await client.close(); } catch { /* Preserve the original connection error. */ } throw error; }
  return client;
}

const installedTargetDirectories = home => ({
  gameDirectory: 'D:/SteamLibrary/steamapps/common/Satisfactory',
  sdkDirectory: join(home, 'tools/satisfactory-sdk-513885'),
});

/** Fixed, read-only game adapter. The optional second argument is a trusted
 * code dependency for offline tests, never a request/configuration field. */
export function createReGameAdapter(options = {}, resolveTargetDirectories = installedTargetDirectories) {
  const { root, openRea = openInstalledRea } = options;
  if (Object.hasOwn(options, '_testTarget')) throw fail('RE_TEST_TARGET_FORBIDDEN', 'Fixture target options are forbidden');
  if (typeof root !== 'string' || typeof openRea !== 'function' || typeof resolveTargetDirectories !== 'function') throw new TypeError('Game RE adapter requires a project root and callable dependencies');
  const home = resolve(root);
  const directories = resolveTargetDirectories(home);
  const registry = Object.freeze({ satisfactory: Object.freeze({
    gameDirectory: resolve(directories.gameDirectory),
    sdkDirectory: resolve(directories.sdkDirectory)
  }) });

  function select(targetId) {
    if (targetId !== 'satisfactory') throw fail('RE_UNKNOWN_TARGET', 'Only the registered Satisfactory adapter is available');
    return registry.satisfactory;
  }
  function validateRun(runId) {
    if (typeof runId !== 'string' || !UUID.test(runId)) throw fail('INVALID_RE_ID', 'A valid investigation run UUID is required');
  }
  async function safeDirectory(parts) {
    const actualHome = await realpath(home);
    let current = actualHome;
    for (const part of ['state', 'local-game-re', 'knowledge', ...parts]) {
      if (!/^[a-z0-9._-]+$/i.test(part)) throw fail('RE_UNSAFE_OUTPUT', 'Invalid evidence path component');
      current = join(current, part);
      try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail('RE_UNSAFE_OUTPUT', 'Evidence directories must be real project directories');
    }
    return current;
  }
  async function save(runId, name, value, extension = 'json') {
    validateRun(runId);
    const directory = await safeDirectory([runId]);
    const content = extension === 'json' ? JSON.stringify(value, null, 2) + '\n' : value;
    if (Buffer.byteLength(content) > MAX_EVIDENCE) throw fail('RE_EVIDENCE_LIMIT', 'One evidence result exceeded the 8 MiB retention limit');
    const path = join(directory, `${name}.${extension}`), temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw fail('RE_UNSAFE_OUTPUT', 'Evidence destination must be a regular file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    return { path, sha256: sha(content), bytes: Buffer.byteLength(content) };
  }

  async function headerIndex(selected, runId, signal) {
    const directory = join(selected.sdkDirectory, 'Source/FactoryGame/Public');
    const headers = [], unknowns = [];
    let declarationCount = 0, truncated = false;
    async function walk(current, depth = 0) {
      checkAbort(signal);
      if (depth > 16) { truncated = true; return; }
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (headers.length >= 20000) { truncated = true; return; }
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) { unknowns.push(`Linked SDK entry was not read: ${relative(directory, path)}`); continue; }
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile() && /\.h$/i.test(entry.name)) {
          const identity = await fingerprint(path, signal);
          if (identity.bytes > 2 * 1024 * 1024) { unknowns.push(`Oversized header declarations were not parsed: ${entry.name}`); headers.push({ ...identity, relativePath: relative(directory, path), declarationCount: null }); continue; }
          const content = await readFile(path, 'utf8');
          if (sha(Buffer.from(content)) !== identity.sha256) throw fail('RE_ARTIFACT_CHANGED', 'SDK header changed between hashing and indexing');
          // These are lexical class/struct/enum declarations, including forwards;
          // they are declarations in the SDK, never recovered native addresses.
          const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
          const declarations = [...stripped.matchAll(/\b(class|struct|enum(?:\s+class)?)\s+(?:\w+_API\s+)?(\w+)/g)];
          declarationCount += declarations.length;
          headers.push({ ...identity, relativePath: relative(directory, path), declarationCount: declarations.length,
            declarationSample: declarations.slice(0, 32).map(match => ({ kind: match[1], name: match[2] })), declarationsOmitted: Math.max(0, declarations.length - 32) });
        }
      }
    }
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail('RE_UNSAFE_ARTIFACT', 'SDK public headers must use a real directory');
      await walk(directory);
    } catch (error) { if (error.code === 'ENOENT') unknowns.push('Selected SDK public headers are unavailable.'); else throw error; }
    const index = { schema: 'copilot.sdk-header-index/v1', runId, generatedAt: now(), selectedSdkChangelist: SELECTED_SDK_CL,
      directory, kind: 'declared-sdk-api', nativeAddressesEstablished: false, declarationScope: 'lexical class/struct/enum declarations including forward declarations',
      headerCount: headers.length, declarationCount, truncated, unknowns, headers };
    const stored = await save(runId, 'sdk-header-index', index);
    return { kind: index.kind, nativeAddressesEstablished: false, selectedSdkChangelist: SELECTED_SDK_CL,
      headerCount: headers.length, declarationCount, truncated, indexFile: stored.path, indexSha256: stored.sha256, unknowns };
  }

  async function target(request = {}) {
    const { targetId, runId, signal, onProgress } = request;
    const selected = select(targetId); validateRun(runId); checkAbort(signal);
    if (['path', 'gameDirectory', 'sdkDirectory', 'provider_id', 'file'].some(key => Object.hasOwn(request, key))) throw fail('RE_TARGET_PATH_FORBIDDEN', 'Target paths are fixed by the registered game adapter');
    const inventory = [], unknowns = [], capabilitiesMissing = [];
    for (const [id, relativePath] of [...FILES, ['modules-metadata', MODULES_FILE]]) {
      checkAbort(signal);
      try { inventory.push({ id, relativePath, ...await fingerprint(join(selected.gameDirectory, relativePath), signal) }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; unknowns.push(`Artifact unavailable: ${relativePath}`); if (id === 'game-dll') capabilitiesMissing.push('Installed main game DLL'); }
    }
    let build = { status: 'unknown', gameVersion: null, changelist: null, buildId: null, source: null };
    for (const relativePath of VERSION_FILES) {
      const path = join(selected.gameDirectory, relativePath);
      try {
        const identity = await fingerprint(path, signal);
        if (identity.bytes > 65536) throw fail('RE_METADATA_LIMIT', 'Installed version metadata exceeded its bound');
        const content = await readFile(path);
        if (sha(content) !== identity.sha256) throw fail('RE_ARTIFACT_CHANGED', 'Installed version metadata changed while reading');
        const value = JSON.parse(content.toString('utf8').replace(/^\uFEFF/, ''));
        inventory.push({ id: 'version-metadata', relativePath, ...identity });
        build = { status: 'observed-installed-metadata', gameVersion: typeof value.GameVersion === 'string' ? value.GameVersion : null,
          changelist: Number.isSafeInteger(value.Changelist) ? value.Changelist : null,
          buildId: typeof value.BuildId === 'string' ? value.BuildId : null, source: path, sha256: identity.sha256 };
        break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!build.source) unknowns.push('Installed game version/changelist is unknown: neither registered version metadata file exists.');
    const headers = await headerIndex(selected, runId, signal);
    unknowns.push(...headers.unknowns, 'SDK declarations do not establish native function addresses, ABI compatibility, or runtime behavior.', 'Inventory fingerprints only the registered game DLL, launcher, Copilot module and build metadata; packed assets and other game modules remain unexamined.');
    if (build.changelist !== SELECTED_SDK_CL) unknowns.push('The selected SDK changelist is not established as matching the installed game build.');
    const raw = { schema: 'copilot.game-target/v1', id: targetId, targetId, runId, capturedAt: now(), gameDirectory: selected.gameDirectory,
      inventory, build, headers, capabilitiesMissing, unknowns, entireGameReverseEngineered: false };
    const stored = await save(runId, 'inventory', raw);
    onProgress?.({ status: 'inventory_recorded', artifactCount: inventory.length, headerCount: headers.headerCount, evidenceFile: stored.path });
    return { ...raw, evidenceFile: stored.path, findings: [
      { claim: `${inventory.length} registered installed artifacts were fingerprinted.`, classification: 'verified', sources: [stored.path] },
      { claim: `${headers.headerCount} SDK headers indexed ${headers.declarationCount} lexical declarations.`, classification: 'verified', sources: [headers.indexFile] }
    ] };
  }

  async function inspect({ target: captured, runId, signal, onProgress } = {}) {
    validateRun(runId); checkAbort(signal);
    const selected = select(captured?.targetId ?? captured?.id);
    const mainPath = join(selected.gameDirectory, FILES[0][1]);
    const main = captured.inventory?.find(file => file.id === 'game-dll');
    if (!main || main.path !== mainPath || !/^[a-f0-9]{64}$/.test(main.sha256)) throw fail('RE_TARGET_IDENTITY', 'Captured game identity does not match the fixed registered artifact');
    const current = await fingerprint(mainPath, signal);
    if (current.sha256 !== main.sha256) throw fail('RE_ARTIFACT_CHANGED', 'Game DLL changed since inventory; it was not inspected under the old fingerprint');
    const evidenceFiles = [], findings = [], unknowns = [...(captured.unknowns ?? [])], capabilitiesMissing = [...(captured.capabilitiesMissing ?? [])];
    const portable = { status: 'unknown' }, native = { status: 'unknown', procedureCount: null, sampledProcedures: 0, matchedProcedures: null,
      coverage: 'unknown', truncation: { sampleLimit: 6, omittedMatches: null } };
    let client, catalog, sequence = 0, cancelled = false;
    const deadline = new AbortController();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const expires = Date.now() + NATIVE_MS;
    const timer = setTimeout(() => deadline.abort(fail('RE_NATIVE_DEADLINE', 'Native inspection exceeded its 15 minute bound')), NATIVE_MS);
    timer.unref?.();
    async function retain(name, args, result, error) {
      const value = { schema: 'copilot.rea-tool-result/v1', runId, at: now(), targetId: 'satisfactory', artifact: main,
        tool: name, arguments: args, ...(result ? { response: result } : {}), ...(error ? { error: errorData(error) } : {}) };
      let stored;
      try { stored = await save(runId, `${String(++sequence).padStart(3, '0')}-${name}`, value); }
      catch (saveError) {
        if (saveError.code !== 'RE_EVIDENCE_LIMIT') throw saveError;
        const serialized = JSON.stringify(value);
        stored = await save(runId, `${String(sequence).padStart(3, '0')}-${name}-omitted`, {
          schema: value.schema, runId, tool: name, artifact: main, retained: false, originalBytes: Buffer.byteLength(serialized), originalSha256: sha(serialized),
          error: errorData(saveError), unknown: 'Oversized tool output was not retained or used as complete evidence.' });
        evidenceFiles.push(stored); throw saveError;
      }
      evidenceFiles.push(stored); return stored;
    }
    function decoded(response) {
      if (response?.structuredContent) return response.structuredContent;
      const text = response?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
      try { return JSON.parse(text); } catch { return null; }
    }
    async function call(name, args, cleanup = false) {
      if (!catalog?.has(name)) throw fail('REA_TOOL_UNAVAILABLE', `REA did not advertise ${name}`);
      if (!cleanup) { checkAbort(signal); if (deadline.signal.aborted) throw fail('RE_NATIVE_DEADLINE', 'Native inspection exceeded its 15 minute bound'); }
      const schema = catalog.get(name).inputSchema;
      if (schema?.additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(schema.properties ?? {}, key))) throw fail('REA_SCHEMA_MISMATCH', `Installed ${name} schema does not accept the selected arguments`);
      if ((schema?.required ?? []).some(key => !Object.hasOwn(args, key))) throw fail('REA_SCHEMA_MISMATCH', `Required ${name} arguments are missing`);
      let response;
      try { response = await client.callTool({ name, arguments: args }, { ...(cleanup ? {} : { signal: combined }), timeout: cleanup ? 15000 : Math.max(1000, expires - Date.now()) }); }
      catch (error) { await retain(name, args, null, error); throw error; }
      const stored = await retain(name, args, response);
      const data = decoded(response);
      if (response?.isError || data?.error) {
        const detail = data?.error ?? data;
        const text = response?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
        throw Object.assign(fail(String(detail?.code ?? 'REA_TOOL_ERROR'), String(detail?.message ?? text ?? 'REA tool returned an error')), { details: detail?.details, evidenceFile: stored.path });
      }
      if (!data) throw fail('REA_UNSTRUCTURED_RESULT', `${name} did not return complete structured evidence`);
      if (data.subject?.digest?.sha256 && data.subject.digest.sha256 !== main.sha256) throw fail('RE_EVIDENCE_IDENTITY', 'REA evidence refers to another artifact fingerprint');
      return { data, file: stored.path };
    }
    try {
      client = await openRea({ root: home, signal: combined });
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { signal: combined, timeout: 30000 });
        if (!Array.isArray(page.tools)) throw fail('REA_CATALOG_INVALID', 'REA tool catalog has an unexpected format');
        tools.push(...page.tools); cursor = page.nextCursor;
        if (tools.length > 512) throw fail('REA_CATALOG_LIMIT', 'REA tool catalog exceeded its bounded inventory');
      } while (cursor);
      catalog = new Map(tools.map(tool => [tool.name, tool]));
      const catalogRecord = { capturedAt: now(), runId, tools };
      evidenceFiles.push(await save(runId, 'rea-tool-catalog', catalogRecord));
      // The run-specific catalog is authoritative; this copy serves the existing status UI.
      const catalogPath = join(home, 'state/local-game-re/rea-tool-catalog.json');
      const catalogInfo = await lstat(catalogPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (catalogInfo?.isSymbolicLink() || (catalogInfo && !catalogInfo.isFile())) throw fail('RE_UNSAFE_OUTPUT', 'REA catalog destination is unsafe');
      await writeFile(catalogPath, JSON.stringify(catalogRecord, null, 2) + '\n');
      try {
        const result = await call('inspect_pe_resources', { path: mainPath, max_file_bytes: 67108864, max_entries: 16384 });
        const normalized = result.data.normalized_result;
        portable.status = 'observed'; portable.format = normalized?.format ?? null;
        portable.coverage = normalized?.coverage ?? null; portable.evidenceId = result.data.evidence_id ?? null; portable.evidenceFile = result.file;
        findings.push({ claim: 'The registered game DLL received portable PE resource inspection without target execution.', classification: 'verified', sources: [result.file] });
      } catch (error) {
        portable.error = errorData(error); unknowns.push(`Portable PE resource inspection unavailable: ${error.message}`);
        capabilitiesMissing.push(`Portable PE resources: ${error.code ?? 'unknown error'}`);
        checkAbort(signal);
      }
      try {
        onProgress?.({ status: 'native_inspection', provider: 'ghidra', artifactSha256: main.sha256 });
        const opened = await call('open_binary', { path: mainPath, provider_id: 'ghidra' });
        if (opened.data.result?.sha256 !== main.sha256) throw fail('RE_EVIDENCE_IDENTITY', 'REA did not confirm the selected game DLL fingerprint');
        const overview = await call('binary_overview', {});
        const count = overview.data.normalized_result?.procedure_count;
        native.procedureCount = Number.isSafeInteger(count) && count >= 0 ? count : null;
        native.overviewEvidenceFile = overview.file;
        const operation = catalog.has('search_procedures') ? 'search_procedures' : 'list_procedures';
        const searched = await call(operation, operation === 'search_procedures' ? { pattern: 'Blueprint|Hologram|Buildable', mode: 'regex', case_sensitive: false } : {});
        const rows = searched.data.normalized_result;
        if (!Array.isArray(rows)) throw fail('REA_PROCEDURES_INVALID', 'REA did not return a complete structured procedure list');
        const matches = rows.filter(row => typeof row?.value === 'string' && /Blueprint|Hologram|Buildable/i.test(row.value));
        const unique = [...new Map(matches.map(row => [row.value, row])).values()];
        native.matchedProcedures = unique.length; native.truncation.omittedMatches = Math.max(0, unique.length - 6); native.samples = [];
        for (const procedure of unique.slice(0, 6)) {
          checkAbort(signal);
          const result = await call('procedure_pseudo_code', { procedure: procedure.value });
          if (typeof result.data.normalized_result !== 'string') throw fail('REA_PSEUDOCODE_INVALID', 'REA did not return structured pseudocode for the selected procedure');
          native.samples.push({ name: procedure.value, address: procedure.address ?? null, evidenceId: result.data.evidence_id ?? null,
            evidenceFile: result.file, pseudocodeBytes: Buffer.byteLength(result.data.normalized_result) });
          native.sampledProcedures = native.samples.length;
        }
        native.status = 'observed'; native.coverage = 'sampled';
        findings.push({ claim: `Ghidra reported ${native.procedureCount ?? 'an unknown number of'} procedures; ${native.sampledProcedures} returned named procedures were sampled as pseudocode.`, classification: 'verified', sources: [overview.file, ...native.samples.map(sample => sample.evidenceFile)] });
        if (!unique.length) unknowns.push('No Blueprint/Hologram/Buildable procedure names were returned; this does not establish that those features are absent.');
      } catch (error) {
        native.status = 'unknown'; native.error = errorData(error);
        unknowns.push(`Native analysis remains unknown: ${error.message}`);
        capabilitiesMissing.push(`Native Ghidra analysis: ${error.code ?? 'unknown error'}`);
        if (signal?.aborted) cancelled = true;
      }
    } catch (error) {
      native.error ??= errorData(error);
      unknowns.push(`REA inspection unavailable: ${error.message}`); capabilitiesMissing.push(`REA connection/catalog: ${error.code ?? 'unknown error'}`);
      if (signal?.aborted) cancelled = true;
    } finally {
      clearTimeout(timer);
      if (client) {
        try { await call('close_binary', {}, true); native.targetClosed = true; }
        catch (error) { native.targetClosed = false; native.cleanupError = errorData(error); unknowns.push(`Native target cleanup could not be confirmed: ${error.message}`); }
        try { await client.close(); native.clientClosed = true; }
        catch (error) { native.clientClosed = false; native.clientCloseError = errorData(error); unknowns.push(`REA client cleanup could not be confirmed: ${error.message}`); }
      }
    }
    unknowns.push('Sampled static pseudocode does not establish complete native behavior, asset behavior, runtime safety, or a reconstruction of the whole game.');
    const result = { schema: 'copilot.game-inspection/v1', runId, targetId: 'satisfactory', artifactSha256: main.sha256,
      analyzedArtifacts: portable.status === 'observed' || native.status === 'observed' ? [main.sha256] : [], portable, native,
      headers: captured.headers, findings, unknowns: [...new Set(unknowns)], capabilitiesMissing: [...new Set(capabilitiesMissing)], evidenceFiles, entireGameReverseEngineered: false };
    const stored = await save(runId, 'inspection-summary', result);
    result.evidenceFile = stored.path;
    onProgress?.({ status: cancelled ? 'cancelled' : 'inspection_recorded', nativeStatus: native.status, sampledProcedures: native.sampledProcedures, evidenceFile: stored.path });
    if (cancelled || signal?.aborted) throw fail('RE_CANCELLED', 'Investigation cancelled after preserving evidence and closing the REA session; external outcomes remain unknown.');
    return result;
  }

  async function publish({ report, runId, targetId, policy } = {}) {
    select(targetId); validateRun(runId);
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw fail('RE_REPORT_INVALID', 'A structured partial investigation report is required');
    const record = { schema: 'copilot.game-re-knowledge/v1', runId, targetId, generatedAt: now(), entireGameReverseEngineered: false,
      policy: policy ?? {}, report: { ...report, entireGameReverseEngineered: false, coverage: { ...report.coverage, completeness: 'unknown' } } };
    const saved = await save(runId, 'shared-report', record);
    const rows = [`# Satisfactory investigation pass`, '', `Run: ${runId}`, '', 'Coverage is partial. Whole-game reverse engineering is not established.', '', '## Findings', ''];
    for (const finding of report.findings ?? []) rows.push(`- [${finding.classification ?? 'unknown'}] ${String(finding.claim ?? finding).replace(/[\r\n]+/g, ' ')}`, `  Sources: ${JSON.stringify(finding.sources ?? [])}`);
    rows.push('', '## Unknowns', '', ...(report.unknowns ?? []).map(value => `- ${String(value).replace(/[\r\n]+/g, ' ')}`), '', `Exact report: ${saved.path}`, '');
    const summary = await save(runId, 'shared-summary', rows.join('\n'), 'md');
    return { saved: true, targetId, runId, reportFile: saved.path, reportSha256: saved.sha256, summaryFile: summary.path,
      findings: [], unknowns: ['This finite report preserves partial observations and does not establish whole-game reconstruction.'], entireGameReverseEngineered: false };
  }

  return { target, inspect, publish };
}
