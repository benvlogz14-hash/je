import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable,
  RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';

// Euclidean's light theme: white base, pastel accents.
const C = {
  bg: '#f7f8fb', card: '#ffffff', line: '#e6e8ef', text: '#1d2333', dim: '#6b7387',
  blue: '#dbe7ff', blueInk: '#2f5bd3', green: '#d9f5e5', greenInk: '#1f8a52',
  pink: '#ffe1e6', pinkInk: '#c23a55', amber: '#fff1d6', amberInk: '#a86a00', lilac: '#ece4ff', lilacInk: '#6a4bc4',
};
const KEY = 'euclidean.link';
// The phone's keychain; falls back to browser storage when previewed on the web.
const vault = {
  get: async () => { try { return await SecureStore.getItemAsync(KEY); } catch { try { return globalThis.localStorage.getItem(KEY); } catch { return null; } } },
  set: async (v) => { try { await SecureStore.setItemAsync(KEY, v); } catch { try { globalThis.localStorage.setItem(KEY, v); } catch {} } },
  clear: async () => { try { await SecureStore.deleteItemAsync(KEY); } catch {} try { globalThis.localStorage.removeItem(KEY); } catch {} },
};

// ---------------------------------------------------------------- connection

/** Accepts the link from Settings → General → Use on your iPhone: http://192.168.1.20:7820/?token=eu_... */
function parseLink(raw) {
  const s = String(raw || '').trim();
  const m = /^(https?:\/\/[^/?#\s]+)[^?#\s]*\?(?:[^#\s]*&)?token=([^&#\s]+)/i.exec(s);
  if (!m) return null;
  return { base: m[1].replace(/\/$/, ''), token: decodeURIComponent(m[2]) };
}

function makeApi(link) {
  const call = async (method, path, body) => {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(link.base + path, {
        method, signal: ctrl.signal,
        headers: { Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError'
        ? 'Euclidean took too long to answer.'
        : 'Can\'t reach Euclidean. Check that the computer is on, Euclidean is open, and your phone is on the same Wi-Fi.');
    } finally { clearTimeout(timer); }
    const text = await res.text(); let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('This phone isn\'t linked any more. Scan the code in Settings → General again.'), { auth: true });
    if (!res.ok) throw new Error((data && data.error) || `Euclidean said: ${res.status}`);
    return data;
  };
  return {
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b),
    file: (p) => `${link.base}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(link.token)}`,
  };
}

const tap = () => Haptics.selectionAsync().catch(() => {});
const ok = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
const fail = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
};
const num = (n) => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

/** Load something from the engine, poll it, and let the screen pull to refresh. */
function useLoad(api, path, every = 15000) {
  const [data, setData] = useState(null); const [error, setError] = useState(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (manual) => {
    if (!path) return; if (manual) setBusy(true);
    try { setData(await api.get(path)); setError(null); } catch (e) { setError(e.message); }
    finally { if (manual) setBusy(false); }
  }, [api, path]);
  useEffect(() => { load(); if (!every) return; const t = setInterval(load, every); return () => clearInterval(t); }, [load, every]);
  return { data, error, busy, reload: () => load(true), refresh: load };
}

// ---------------------------------------------------------------- small pieces

function Button({ title, onPress, tone = 'blue', small, disabled }) {
  const bg = { blue: C.blue, green: C.green, pink: C.pink, amber: C.amber, lilac: C.lilac, plain: C.card }[tone];
  const ink = { blue: C.blueInk, green: C.greenInk, pink: C.pinkInk, amber: C.amberInk, lilac: C.lilacInk, plain: C.text }[tone];
  return (
    <Pressable disabled={disabled} onPress={() => { tap(); onPress && onPress(); }}
      style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }, tone === 'plain' && { borderWidth: 1, borderColor: C.line }]}>
      <Text style={[s.btnText, small && { fontSize: 13 }, { color: ink }]}>{title}</Text>
    </Pressable>
  );
}
const Pill = ({ text, tone = 'blue' }) => (
  <View style={[s.pill, { backgroundColor: C[tone] }]}><Text style={[s.pillText, { color: C[tone + 'Ink'] }]}>{text}</Text></View>
);
const Empty = ({ title, text }) => (
  <View style={s.empty}><Text style={s.emptyTitle}>{title}</Text>{text ? <Text style={s.emptyText}>{text}</Text> : null}</View>
);
const ErrorBar = ({ text }) => (text ? <View style={s.errorBar}><Text style={s.errorText}>{text}</Text></View> : null);
const Header = ({ title, right }) => (
  <View style={s.header}><Text style={s.h1}>{title}</Text>{right}</View>
);

async function act(fn, done) {
  try { await fn(); ok(); done && done(); } catch (e) { fail(); Alert.alert('That didn\'t work', e.message); }
}

// ---------------------------------------------------------------- connect

function Connect({ onLinked, initialError }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState(initialError || null);
  const [checking, setChecking] = useState(false);
  const seen = useRef(false);

  const tryLink = async (raw) => {
    const link = parseLink(raw);
    if (!link) { fail(); setError('That isn\'t a Euclidean phone link. It looks like http://192.168.x.x:7820/?token=eu_…'); return; }
    setChecking(true); setError(null);
    try {
      const boot = await makeApi(link).get('/api/bootstrap');
      await vault.set(JSON.stringify(link));
      ok(); onLinked(link, boot);
    } catch (e) { fail(); setError(e.message); seen.current = false; }
    finally { setChecking(false); }
  };

  const startScan = async () => {
    if (!perm || !perm.granted) { const r = await requestPerm(); if (!r.granted) { setError('Camera access is off. You can paste the link instead.'); return; } }
    seen.current = false; setScanning(true);
  };

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => { if (seen.current) return; seen.current = true; setScanning(false); tryLink(data); }} />
        <View style={s.scanHint}>
          <Text style={s.scanHintText}>Point at the code in Euclidean → Settings → General → Use on your iPhone</Text>
          <Button title="Cancel" tone="plain" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.connect} keyboardShouldPersistTaps="handled">
        <View style={s.logo}><Text style={s.logoText}>E</Text></View>
        <Text style={s.title}>Euclidean</Text>
        <Text style={s.lead}>Link this phone to Euclidean on your computer to approve clips and messages, chat with your agents and check on things from anywhere in the house.</Text>
        <View style={s.card}>
          <Text style={s.step}>1. On the computer, open Euclidean → Settings → General → <Text style={{ fontWeight: '700' }}>Use on your iPhone</Text>. Turn on phone access, then press “Create my phone link”.</Text>
          <Text style={s.step}>2. Scan the code it shows.</Text>
          <Button title={checking ? 'Checking…' : 'Scan the code'} onPress={startScan} disabled={checking} />
        </View>
        <View style={s.card}>
          <Text style={s.label}>Or paste the link</Text>
          <TextInput value={paste} onChangeText={setPaste} placeholder="http://192.168.1.20:7820/?token=eu_…" placeholderTextColor={C.dim}
            autoCapitalize="none" autoCorrect={false} style={s.input} onSubmitEditing={() => tryLink(paste)} returnKeyType="go" />
          <Button title="Link" tone="lilac" onPress={() => tryLink(paste)} disabled={checking || !paste.trim()} />
        </View>
        {checking ? <ActivityIndicator style={{ marginTop: 12 }} /> : null}
        <ErrorBar text={error} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------- approvals

function Approvals({ api }) {
  const { data, error, busy, reload, refresh } = useLoad(api, '/api/approvals', 10000);
  const agentAsks = useLoad(api, '/api/agentnet/approvals', 10000);
  const items = [
    ...(agentAsks.data || []).map((a) => ({ ...a, kind: 'agent' })),
    ...(data || []),
  ];
  const after = () => { refresh(); agentAsks.refresh(); };

  const decideClip = (a, decision) => act(() => api.post(`/api/clips/${a.refId}/decide`, { decision, note: '' }), after);
  const askChanges = (a) => Alert.prompt
    ? Alert.prompt('What should change?', '', (note) => act(() => api.post(`/api/clips/${a.refId}/decide`, { decision: 'changes', note }), after))
    : decideClip(a, 'changes');

  const render = ({ item: a }) => {
    if (a.kind === 'clip') {
      return (
        <View style={s.card}>
          <View style={s.row}><Pill text="Clip" tone="lilac" />{a.client ? <Text style={s.meta}>{a.client}</Text> : null}</View>
          <Pressable onPress={() => Linking.openURL(api.file(`/api/clips/${a.refId}/video`))}>
            <Image source={{ uri: api.file(`/api/clips/${a.refId}/thumb`) }} style={s.thumb} resizeMode="cover" />
            <Text style={s.play}>▶︎ Tap to watch</Text>
          </Pressable>
          <Text style={s.cardTitle}>{a.ref?.title || a.ref?.ref || 'Clip'}</Text>
          {a.ref?.current?.duration ? <Text style={s.meta}>{Math.round(a.ref.current.duration)}s · version {a.ref.current.n}</Text> : null}
          <View style={s.actions}>
            <Button small title="Approve" tone="green" onPress={() => decideClip(a, 'approve')} />
            <Button small title="Changes" tone="amber" onPress={() => askChanges(a)} />
            <Button small title="Reject" tone="pink" onPress={() => decideClip(a, 'reject')} />
          </View>
        </View>
      );
    }
    if (a.kind === 'message') {
      return (
        <View style={s.card}>
          <View style={s.row}><Pill text={a.channel === 'email' ? 'Email' : 'Text'} tone="blue" /><Text style={s.meta}>to {a.contact || 'contact'}{a.client ? ` · ${a.client}` : ''}</Text></View>
          {a.subject ? <Text style={s.cardTitle}>{a.subject}</Text> : null}
          <Text style={s.body}>{a.body}</Text>
          <View style={s.actions}>
            <Button small title="Send it" tone="green" onPress={() => act(() => api.post(`/api/messages/${a.refId}/approve`, {}), after)} />
            <Button small title="Discard" tone="pink" onPress={() => act(() => api.post(`/api/messages/${a.refId}/discard`, {}), after)} />
          </View>
        </View>
      );
    }
    return (
      <View style={s.card}>
        <View style={s.row}><Pill text="Agent request" tone="amber" /><Text style={s.meta}>{a.fromName} · {a.workspaceLabel}</Text></View>
        <Text style={s.body}>{a.summary}</Text>
        {a.command ? <Text style={s.code}>{a.command}</Text> : null}
        <View style={s.actions}>
          <Button small title="Allow" tone="green" onPress={() => act(() => api.post(`/api/agentnet/approvals/${a.id}/decide`, { approve: true }), after)} />
          <Button small title="Decline" tone="pink" onPress={() => act(() => api.post(`/api/agentnet/approvals/${a.id}/decide`, { approve: false }), after)} />
        </View>
      </View>
    );
  };

  return (
    <FlatList data={items} keyExtractor={(a) => `${a.kind}:${a.id}`} renderItem={render} contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={() => { reload(); agentAsks.reload(); }} />}
      ListHeaderComponent={<><Header title="Approvals" right={items.length ? <Pill text={String(items.length)} tone="pink" /> : null} /><ErrorBar text={error || agentAsks.error} /></>}
      ListEmptyComponent={data ? <Empty title="All caught up" text="Clips, messages and agent requests that need you show up here." /> : <ActivityIndicator style={{ marginTop: 40 }} />} />
  );
}

// ---------------------------------------------------------------- chat (command thread + client conversations)

function Thread({ api, conv, onBack }) {
  const { data, error, refresh } = useLoad(api, `/api/conversations/${conv.id}/messages?limit=80`, 5000);
  const [text, setText] = useState(''); const [sending, setSending] = useState(false);
  const list = useRef(null);
  const isCommand = conv.kind === 'command';
  useEffect(() => { api.post(`/api/conversations/${conv.id}/read`).catch(() => {}); }, [api, conv.id]);

  const send = async () => {
    const body = text.trim(); if (!body) return;
    setSending(true);
    try {
      if (isCommand) await api.post('/api/command', { text: body, conversationId: conv.id });
      else await api.post(`/api/conversations/${conv.id}/messages`, { body, channel: conv.channel || undefined });
      setText(''); ok(); refresh();
    } catch (e) { fail(); Alert.alert('Not sent', e.message); }
    finally { setSending(false); }
  };

  const msgs = (data || []).filter((m) => m.body);
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }} keyboardVerticalOffset={70}>
      <View style={s.threadHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹ Back</Text></Pressable>
        <Text style={s.threadTitle} numberOfLines={1}>{isCommand ? 'Euclidean assistant' : conv.contact?.name || conv.title || 'Conversation'}</Text>
      </View>
      <ErrorBar text={error} />
      <FlatList ref={list} data={msgs} keyExtractor={(m) => m.id} contentContainerStyle={{ padding: 12 }}
        onContentSizeChange={() => list.current && list.current.scrollToEnd({ animated: false })}
        renderItem={({ item: m }) => {
          const mine = m.direction === 'out'; const note = m.direction === 'internal';
          return (
            <View style={[s.bubble, mine ? s.mine : note ? s.note : s.theirs]}>
              <Text style={[s.bubbleText, mine && { color: C.blueInk }]}>{m.body}</Text>
              <Text style={s.bubbleMeta}>{m.status === 'pending_approval' ? 'Waiting for approval · ' : ''}{ago(m.createdAt)}</Text>
            </View>
          );
        }}
        ListEmptyComponent={data ? <Empty title={isCommand ? 'Ask Euclidean anything' : 'No messages yet'} text={isCommand ? 'Try “status”, “what needs approval?” or “/help”.' : ''} /> : <ActivityIndicator style={{ marginTop: 40 }} />} />
      <View style={s.composer}>
        <TextInput value={text} onChangeText={setText} placeholder={isCommand ? 'Type a request or /command' : 'Write a message (it waits for approval)'}
          placeholderTextColor={C.dim} style={[s.input, { flex: 1, marginBottom: 0 }]} multiline />
        <Button small title={sending ? '…' : 'Send'} onPress={send} disabled={sending || !text.trim()} />
      </View>
    </KeyboardAvoidingView>
  );
}

function Chat({ api }) {
  const { data, error, busy, reload } = useLoad(api, '/api/conversations', 15000);
  const [open, setOpen] = useState(null);
  if (open) return <Thread api={api} conv={open} onBack={() => { setOpen(null); reload(); }} />;
  return (
    <FlatList data={data || []} keyExtractor={(c) => c.id} contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={reload} />}
      ListHeaderComponent={<><Header title="Chat" /><ErrorBar text={error} /></>}
      renderItem={({ item: c }) => (
        <Pressable onPress={() => { tap(); setOpen(c); }} style={({ pressed }) => [s.card, s.rowCard, pressed && { opacity: 0.7 }]}>
          <View style={[s.avatar, { backgroundColor: c.kind === 'command' ? C.lilac : C.blue }]}>
            <Text style={s.avatarText}>{c.kind === 'command' ? '✦' : (c.contact?.name || c.title || '?').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle} numberOfLines={1}>{c.kind === 'command' ? 'Euclidean assistant' : c.contact?.name || c.title || 'Conversation'}</Text>
            <Text style={s.meta} numberOfLines={1}>{c.lastPreview || c.preview || ago(c.lastMessageAt)}</Text>
          </View>
          {c.pendingApprovals ? <Pill text={`${c.pendingApprovals} to approve`} tone="amber" /> : c.unread ? <Pill text={String(c.unread)} tone="pink" /> : null}
        </Pressable>
      )}
      ListEmptyComponent={data ? <Empty title="No conversations" /> : <ActivityIndicator style={{ marginTop: 40 }} />} />
  );
}

// ---------------------------------------------------------------- studio: tell the AI what to change

function Studio({ api }) {
  const { data, error, busy, reload } = useLoad(api, '/api/projects', 0);
  const [pick, setPick] = useState(null); const [text, setText] = useState('');
  const [working, setWorking] = useState(false); const [log, setLog] = useState([]);

  const run = async () => {
    const instruction = text.trim(); if (!instruction || !pick) return;
    setWorking(true);
    try {
      const r = await api.post(`/api/projects/${pick.id}/ai-edit`, { instruction });
      setLog((l) => [{ q: instruction, a: r.say || (r.changed ? 'Done.' : 'Nothing changed.'), errors: r.errors || [] }, ...l]);
      setText(''); r.changed ? ok() : fail();
    } catch (e) { fail(); setLog((l) => [{ q: instruction, a: e.message, errors: [] }, ...l]); }
    finally { setWorking(false); }
  };
  const undo = () => act(async () => { await api.post(`/api/projects/${pick.id}/ai-undo`); setLog((l) => [{ q: 'Undo', a: 'Reverted the last AI change.', errors: [] }, ...l]); });

  if (!pick) {
    return (
      <FlatList data={data || []} keyExtractor={(p) => p.id} contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={reload} />}
        ListHeaderComponent={<><Header title="Studio" /><Text style={s.lead2}>Pick an edit and tell the AI what to change. It edits the timeline on your computer.</Text><ErrorBar text={error} /></>}
        renderItem={({ item: p }) => (
          <Pressable onPress={() => { tap(); setPick(p); setLog([]); }} style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }]}>
            <Text style={s.cardTitle}>{p.name || 'Untitled edit'}</Text>
            <Text style={s.meta}>{p.media} media · updated {ago(p.updatedAt)}</Text>
          </Pressable>
        )}
        ListEmptyComponent={data ? <Empty title="No Studio edits yet" text="Create one in Studio on the computer." /> : <ActivityIndicator style={{ marginTop: 40 }} />} />
    );
  }
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }} keyboardVerticalOffset={70}>
      <View style={s.threadHead}>
        <Pressable onPress={() => setPick(null)} hitSlop={12}><Text style={s.back}>‹ Edits</Text></Pressable>
        <Text style={s.threadTitle} numberOfLines={1}>{pick.name || 'Untitled edit'}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12 }} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <TextInput value={text} onChangeText={setText} multiline style={[s.input, { minHeight: 80 }]} placeholderTextColor={C.dim}
            placeholder="e.g. Add a hook title “Wait for it” for the first 3 seconds, then zoom the first clip in slowly" />
          <View style={s.actions}>
            <Button title={working ? 'Working…' : 'Make the change'} onPress={run} disabled={working || !text.trim()} />
            <Button title="Undo" tone="plain" onPress={undo} disabled={working} />
          </View>
          {working ? <ActivityIndicator style={{ marginTop: 8 }} /> : null}
        </View>
        {['Add a subscribe reminder at the end', 'Add crossfades between every clip', 'Make the first clip zoom in slowly'].map((x) => (
          <Pressable key={x} onPress={() => setText(x)} style={s.suggest}><Text style={s.suggestText}>{x}</Text></Pressable>
        ))}
        {log.map((l, i) => (
          <View key={i} style={s.card}>
            <Text style={s.meta}>You: {l.q}</Text>
            <Text style={s.body}>{l.a}</Text>
            {l.errors.map((e, j) => <Text key={j} style={[s.meta, { color: C.pinkInk }]}>{typeof e === 'string' ? e : e.error || JSON.stringify(e)}</Text>)}
          </View>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------- agents

function AgentThread({ api, thread, onBack }) {
  const { data, error, refresh } = useLoad(api, `/api/agentnet/threads/${thread.id}/messages`, 4000);
  const [text, setText] = useState(''); const list = useRef(null);
  const send = () => act(async () => { await api.post(`/api/agentnet/threads/${thread.id}/messages`, { to: ['*'], type: 'message', body: text.trim() }); setText(''); refresh(); });
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }} keyboardVerticalOffset={70}>
      <View style={s.threadHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹ Back</Text></Pressable>
        <Text style={s.threadTitle} numberOfLines={1}>{thread.title}</Text>
      </View>
      <ErrorBar text={error} />
      <FlatList ref={list} data={data || []} keyExtractor={(m) => m.id} contentContainerStyle={{ padding: 12 }}
        onContentSizeChange={() => list.current && list.current.scrollToEnd({ animated: false })}
        renderItem={({ item: m }) => {
          const human = String(m.from).startsWith('human:');
          const failed = Object.values(m.deliveries || {}).some((d) => d.status === 'failed');
          return (
            <View style={[s.bubble, human ? s.mine : m.type === 'system' ? s.note : s.theirs]}>
              <Text style={s.bubbleMeta}>{m.fromName} → {(m.toNames || []).join(', ')}{m.type !== 'message' && m.type !== 'reply' ? ` · ${m.type.replace('_', ' ')}` : ''}</Text>
              <Text style={s.bubbleText}>{m.body}</Text>
              {failed ? <Text style={[s.bubbleMeta, { color: C.pinkInk }]}>Couldn't deliver to every agent</Text> : null}
            </View>
          );
        }}
        ListEmptyComponent={data ? <Empty title="No messages yet" /> : <ActivityIndicator style={{ marginTop: 40 }} />} />
      <View style={s.composer}>
        <TextInput value={text} onChangeText={setText} placeholder="Message every agent in this thread" placeholderTextColor={C.dim} style={[s.input, { flex: 1, marginBottom: 0 }]} multiline />
        <Button small title="Send" onPress={send} disabled={!text.trim()} />
      </View>
    </KeyboardAvoidingView>
  );
}

function Agents({ api }) {
  const { data, error, busy, reload } = useLoad(api, '/api/agentnet/threads', 10000);
  const st = useLoad(api, '/api/agentnet/status', 10000);
  const [open, setOpen] = useState(null);
  if (open) return <AgentThread api={api} thread={open} onBack={() => { setOpen(null); reload(); }} />;
  const paused = st.data?.paused;
  return (
    <FlatList data={data || []} keyExtractor={(t) => t.id} contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={() => { reload(); st.reload(); }} />}
      ListHeaderComponent={<>
        <Header title="Agents" right={<Button small title={paused ? 'Resume all' : 'Pause all'} tone={paused ? 'green' : 'amber'}
          onPress={() => act(() => api.post('/api/agentnet/pause', { paused: !paused }), st.refresh)} />} />
        {paused ? <View style={[s.card, { backgroundColor: C.amber }]}><Text style={{ color: C.amberInk }}>Agents are paused. Nothing is delivered until you resume.</Text></View> : null}
        <ErrorBar text={error} />
      </>}
      renderItem={({ item: t }) => (
        <Pressable onPress={() => { tap(); setOpen(t); }} style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }]}>
          <View style={s.row}>
            <Text style={[s.cardTitle, { flex: 1 }]} numberOfLines={1}>{t.title}</Text>
            {t.working ? <Pill text="Working" tone="blue" /> : null}
            {t.approvals ? <Pill text="Needs you" tone="amber" /> : null}
            {t.failed ? <Pill text="Failed" tone="pink" /> : null}
          </View>
          <Text style={s.meta}>{(t.participantNames || []).join(', ')} · {t.workspaceLabel} · {ago(t.lastAt)}</Text>
        </Pressable>
      )}
      ListEmptyComponent={data ? <Empty title="No agent conversations" text="Start one in Settings → Agent Connections on the computer." /> : <ActivityIndicator style={{ marginTop: 40 }} />} />
  );
}

// ---------------------------------------------------------------- creators

function Creators({ api }) {
  const { data, error, busy, reload } = useLoad(api, '/api/creators', 0);
  const [open, setOpen] = useState(null);
  const rep = useLoad(api, open ? `/api/creators/${open.id}/report` : null, 0);
  if (open) {
    const r = rep.data;
    return (
      <ScrollView contentContainerStyle={s.list}>
        <Pressable onPress={() => setOpen(null)} hitSlop={12}><Text style={s.back}>‹ Creators</Text></Pressable>
        <Header title={open.name} right={open.stats?.grade ? <Pill text={open.stats.grade} tone="lilac" /> : null} />
        <ErrorBar text={rep.error} />
        {!r ? <ActivityIndicator style={{ marginTop: 40 }} /> : <>
          <View style={s.stats}>
            {[['Followers', num(r.summary?.followers)], ['30-day gain', num(r.summary?.followersGained30d)], ['Views (30d uploads)', num(r.summary?.viewsOnUploads30d)], ['Uploads (30d)', num(r.summary?.uploads30d)]].map(([k, v]) => (
              <View key={k} style={s.stat}><Text style={s.statValue}>{v}</Text><Text style={s.statLabel}>{k}</Text></View>
            ))}
          </View>
          {r.summary?.estEarnings30d ? <View style={s.card}><Text style={s.meta}>Estimated earnings, last 30 days</Text><Text style={s.cardTitle}>${num(r.summary.estEarnings30d.low)} – ${num(r.summary.estEarnings30d.high)}</Text></View> : null}
          <Text style={s.section}>By month</Text>
          {(r.months || []).slice(-12).reverse().map((m) => (
            <View key={m.month} style={[s.card, s.row]}>
              <Text style={[s.cardTitle, { width: 80 }]}>{m.month}</Text>
              <Text style={[s.meta, { flex: 1 }]}>{m.uploads} uploads · {num(m.views)} views{m.followersDelta != null ? ` · ${m.followersDelta >= 0 ? '+' : ''}${num(m.followersDelta)} followers` : ''}</Text>
            </View>
          ))}
          {(r.projections || []).length ? <Text style={s.section}>Projections</Text> : null}
          {(r.projections || []).map((p) => (
            <View key={p.label} style={[s.card, s.row]}><Text style={[s.cardTitle, { width: 80 }]}>{p.label}</Text><Text style={s.meta}>{num(p.followers)} followers · {num(p.views)} views</Text></View>
          ))}
          <Button title="Open in the browser" tone="plain" onPress={() => open.url && Linking.openURL(open.url)} />
        </>}
      </ScrollView>
    );
  }
  return (
    <FlatList data={data || []} keyExtractor={(c) => c.id} contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={reload} />}
      ListHeaderComponent={<><Header title="Creators" /><ErrorBar text={error} /></>}
      renderItem={({ item: c }) => (
        <Pressable onPress={() => { tap(); setOpen(c); }} style={({ pressed }) => [s.card, s.rowCard, pressed && { opacity: 0.7 }]}>
          <Text style={s.rank}>{c.rank ? `#${c.rank}` : '–'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle} numberOfLines={1}>{c.name}</Text>
            <Text style={s.meta}>{c.platform} · {num(c.followers)} followers{c.stats?.followersGained30d ? ` · +${num(c.stats.followersGained30d)} in 30d` : ''}</Text>
          </View>
          {c.stats?.grade ? <Pill text={c.stats.grade} tone="lilac" /> : null}
        </Pressable>
      )}
      ListEmptyComponent={data ? <Empty title="No creators tracked" text="Add creators in Analytics → Creators on the computer." /> : <ActivityIndicator style={{ marginTop: 40 }} />} />
  );
}


// ---------------------------------------------------------------- leads (outreach review + scout chat)

function Leads({ api }) {
  const [lane, setLane] = useState('political');
  const [view, setView] = useState('review');
  const q = useLoad(api, `/api/outreach/${lane}/review`, 15000);
  const st = useLoad(api, '/api/outreach/status', 20000);
  const s = st.data?.[lane] || {};
  const approve = (it) => act(() => api.post('/api/outreach/approve', { ids: [it.id] }), q.refresh);
  const skip = (it) => {
    const go = (reason) => act(() => api.post('/api/outreach/skip', { ids: [it.id], reason: reason || '' }), q.refresh);
    if (Alert.prompt) Alert.prompt('Skip this lead?', 'Why? (optional, the scout learns from it)', [{ text: 'Cancel', style: 'cancel' }, { text: 'Skip', onPress: go }]);
    else go('');
  };
  const vids = [['v', 'posterV', 'Short vertical'], ['h', 'posterH', 'Short horizontal'], ['hl', 'posterHL', 'Long']];
  const header = (
    <>
      <Header title="Leads" />
      <View style={s2.seg}>{[['political', 'Politics'], ['creators', 'Creators']].map(([k, l]) => (
        <Pressable key={k} onPress={() => { tap(); setLane(k); }} style={[s2.segBtn, lane === k && s2.segOn]}><Text style={[s2.segText, lane === k && { color: C.blueInk }]}>{l}</Text></Pressable>
      ))}</View>
      <View style={s.stats}>
        {[['Waiting', s.waiting ?? '–'], ['Sent today', `${s.sentToday ?? 0}/${s.capToday ?? '–'}`], ['New leads today', s.leadsToday ?? 0], ['Scouting', s.scout ? (s.continuous ? 'all day' : 'daily') : 'off']].map(([k, v]) => (
          <View key={k} style={s.stat}><Text style={s.statValue}>{v}</Text><Text style={s.statLabel}>{k}</Text></View>
        ))}
      </View>
      <View style={s2.seg}>{[['review', 'Review'], ['chat', 'Talk to the scout']].map(([k, l]) => (
        <Pressable key={k} onPress={() => { tap(); setView(k); }} style={[s2.segBtn, view === k && s2.segOn]}><Text style={[s2.segText, view === k && { color: C.blueInk }]}>{l}</Text></Pressable>
      ))}</View>
      <ErrorBar text={q.error} />
    </>
  );
  if (view === 'chat') return <ScoutChat api={api} lane={lane} header={header} />;
  return (
    <FlatList data={q.data || []} keyExtractor={(it) => it.id} contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={q.busy} onRefresh={q.reload} />} ListHeaderComponent={header}
      ListEmptyComponent={q.data ? <Empty title="Nothing waiting" text="New leads appear here, ready to approve." /> : <ActivityIndicator style={{ marginTop: 40 }} />}
      renderItem={({ item: it }) => (
        <View style={s.card}>
          <View style={s.row}><Text style={[s.cardTitle, { flex: 1 }]} numberOfLines={1}>{it.name}</Text>{it.hasContrast ? <Pill text="Contrast" tone="pink" /> : null}</View>
          <Text style={s.meta} numberOfLines={1}>{it.office || it.handle || ''}</Text>
          <Text style={s.meta} numberOfLines={1}>To {it.to}</Text>
          {lane === 'political' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6 }}>
              {vids.filter(([k]) => it.files.includes(k)).map(([k, pk, label]) => (
                <Pressable key={k} onPress={() => Linking.openURL(api.file(`/api/prospects/${it.id}/file/${k}`))} style={{ marginRight: 10 }}>
                  <Image source={{ uri: api.file(`/api/prospects/${it.id}/file/${pk}`) }} style={{ width: k === 'v' ? 90 : 160, height: 160, borderRadius: 10, backgroundColor: '#111' }} resizeMode="cover" />
                  <Text style={s.meta}>▶︎ {label}</Text>
                </Pressable>
              ))}
              {it.files.includes('sheet') ? <Pressable onPress={() => Linking.openURL(api.file(`/api/prospects/${it.id}/file/sheet`))} style={{ width: 90, height: 160, borderRadius: 10, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' }}><Text style={s.cardTitle}>PDF</Text><Text style={s.meta}>One-pager</Text></Pressable> : null}
            </ScrollView>
          ) : null}
          <Text style={s.cardTitle}>{it.subject}</Text>
          <Text style={s.body} numberOfLines={8}>{it.body}</Text>
          {it.why.length ? <View style={[s.row, { marginTop: 4 }]}>{it.why.map((w) => <Pill key={w} text={w} tone="amber" />)}</View> : null}
          <View style={s.actions}>
            <Button small title="Approve & send" tone="green" onPress={() => approve(it)} />
            <Button small title="Skip" tone="pink" onPress={() => skip(it)} />
          </View>
        </View>
      )} />
  );
}

function ScoutChat({ api, lane, header }) {
  const { data, refresh } = useLoad(api, `/api/outreach/${lane}/chat`, 10000);
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const list = useRef(null);
  const send = async () => {
    const t = text.trim(); if (!t) return;
    setBusy(true); setText('');
    try { await api.post(`/api/outreach/${lane}/chat`, { text: t }); ok(); } catch (e) { fail(); Alert.alert('Not sent', e.message); }
    setBusy(false); refresh();
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }} keyboardVerticalOffset={70}>
      <FlatList ref={list} data={data || []} keyExtractor={(m) => m.id} contentContainerStyle={s.list} ListHeaderComponent={header}
        onContentSizeChange={() => list.current && list.current.scrollToEnd({ animated: false })}
        ListEmptyComponent={<Empty title="Tell the scout what you want" text={'e.g. "Find Connecticut Democrats running for state house, 40 a day, keep going"'} />}
        renderItem={({ item: m }) => (
          <View style={[s.bubble, m.role === 'user' ? s.mine : s.theirs]}>
            <Text style={s.bubbleText}>{m.text}</Text>
            {(m.changes || []).map((c) => <Text key={c} style={[s.bubbleMeta, { color: C.greenInk }]}>✓ {c}</Text>)}
          </View>
        )} />
      <View style={s.composer}>
        <TextInput value={text} onChangeText={setText} placeholder="Who should it find? What to avoid?" placeholderTextColor={C.dim} style={[s.input, { flex: 1, marginBottom: 0 }]} multiline />
        <Button small title={busy ? '…' : 'Send'} onPress={send} disabled={busy || !text.trim()} />
      </View>
    </KeyboardAvoidingView>
  );
}

const s2 = StyleSheet.create({
  seg: { flexDirection: 'row', backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 3, marginBottom: 10 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center' },
  segOn: { backgroundColor: C.blue },
  segText: { fontSize: 14, fontWeight: '700', color: C.dim },
});

// ---------------------------------------------------------------- status

function Status({ api, link, boot, onUnlink, onCreators }) {
  const q = useLoad(api, '/api/queue/stats', 8000);
  const h = useLoad(api, '/api/health', 0);
  const paused = q.data?.paused;
  const tone = { ok: 'green', warn: 'amber', error: 'pink', setup: 'blue' };
  return (
    <ScrollView contentContainerStyle={s.list} refreshControl={<RefreshControl refreshing={q.busy || h.busy} onRefresh={() => { q.reload(); h.reload(); }} />}>
      <Header title="Status" />
      <ErrorBar text={q.error || h.error} />
      <View style={s.stats}>
        {[['Running', q.data?.running], ['Queued', q.data?.queued], ['Done today', q.data?.done24h], ['Failed today', q.data?.failed24h]].map(([k, v]) => (
          <View key={k} style={s.stat}><Text style={s.statValue}>{v ?? '–'}</Text><Text style={s.statLabel}>{k}</Text></View>
        ))}
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>{paused ? 'Emergency stop is on' : 'Automation is running'}</Text>
        <Text style={s.meta}>{paused ? 'Nothing is sent or published until you resume.' : 'Stop pauses every send, post and render right away.'}</Text>
        <Button title={paused ? 'Resume automation' : 'Emergency stop'} tone={paused ? 'green' : 'pink'}
          onPress={() => paused ? act(() => api.post('/api/queue/resume'), q.refresh)
            : Alert.alert('Stop everything?', 'Nothing will be sent or published until you resume.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Stop', style: 'destructive', onPress: () => act(() => api.post('/api/queue/pause'), q.refresh) }])} />
      </View>
      <Text style={s.section}>Health</Text>
      {(h.data?.items || []).map((i) => (
        <View key={i.key} style={s.card}>
          <View style={s.row}><Text style={[s.cardTitle, { flex: 1 }]}>{i.label}</Text><Pill text={{ ok: 'OK', warn: 'Check', error: 'Problem', setup: 'Not set up' }[i.level] || i.level} tone={tone[i.level] || 'blue'} /></View>
          <Text style={s.meta}>{i.text}</Text>
          {i.level === 'warn' || i.level === 'error' ? <Text style={[s.meta, { color: C.text }]}>Fix: {i.fix}</Text> : null}
        </View>
      ))}
      <Text style={s.section}>Analytics</Text>
      <View style={s.card}><Text style={s.meta}>Creator rankings, monthly stats and projections.</Text><Button title="Open creator stats" tone="lilac" onPress={onCreators} /></View>
      <Text style={s.section}>This phone</Text>
      <View style={s.card}>
        <Text style={s.meta}>Linked to {link.base}{boot?.user ? ` as ${boot.user.name}` : ''}{boot?.version ? ` · Euclidean ${boot.version}` : ''}</Text>
        <Button title="Unlink this phone" tone="plain" onPress={() => Alert.alert('Unlink?', 'You\'ll need to scan the code again.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Unlink', style: 'destructive', onPress: onUnlink }])} />
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- app shell

const TABS = [
  { key: 'approvals', label: 'Approve', icon: '✓' },
  { key: 'chat', label: 'Chat', icon: '✉︎' },
  { key: 'studio', label: 'Studio', icon: '✂︎' },
  { key: 'agents', label: 'Agents', icon: '⚇' },
  { key: 'leads', label: 'Leads', icon: '★' },
  { key: 'status', label: 'Status', icon: '●' },
];

export default function App() {
  const [link, setLink] = useState(undefined); // undefined = loading, null = not linked
  const [boot, setBoot] = useState(null); const [tab, setTab] = useState('approvals');
  const [authError, setAuthError] = useState(null);
  const api = useRef(null);
  if (link && (!api.current || api.current.link !== link)) api.current = { link, ...makeApi(link) };

  useEffect(() => {
    vault.get().then(async (raw) => {
      const saved = raw ? JSON.parse(raw) : null;
      if (!saved) return setLink(null);
      setLink(saved);
      try { setBoot(await makeApi(saved).get('/api/bootstrap')); }
      catch (e) { if (e.auth) { await vault.clear(); setAuthError(e.message); setLink(null); } }
    }).catch(() => setLink(null));
  }, []);

  const unlink = async () => { await vault.clear(); setBoot(null); setLink(null); };

  let screen;
  if (link === undefined) screen = <ActivityIndicator style={{ flex: 1 }} />;
  else if (!link) screen = <Connect initialError={authError} onLinked={(l, b) => { setAuthError(null); setLink(l); setBoot(b); setTab('approvals'); }} />;
  else {
    const a = api.current;
    screen = (
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          {tab === 'approvals' && <Approvals api={a} />}
          {tab === 'chat' && <Chat api={a} />}
          {tab === 'studio' && <Studio api={a} />}
          {tab === 'agents' && <Agents api={a} />}
          {tab === 'leads' && <Leads api={a} />}
          {tab === 'creators' && <Creators api={a} />}
          {tab === 'status' && <Status api={a} link={link} boot={boot} onUnlink={unlink} onCreators={() => setTab('creators')} />}
        </View>
        <View style={s.tabs}>
          {TABS.map((t) => (
            <Pressable key={t.key} onPress={() => { tap(); setTab(t.key); }} style={s.tab}>
              <View style={[s.tabIcon, tab === t.key && { backgroundColor: C.blue }]}><Text style={[s.tabIconText, tab === t.key && { color: C.blueInk }]}>{t.icon}</Text></View>
              <Text style={[s.tabLabel, tab === t.key && { color: C.blueInk, fontWeight: '700' }]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      {screen}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 28 : 0 },
  list: { padding: 14, paddingBottom: 30 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 },
  h1: { fontSize: 28, fontWeight: '800', color: C.text, flexShrink: 1 },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.line, gap: 6 },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardTitle: { fontSize: 16, fontWeight: '700', color: C.text },
  meta: { fontSize: 13, color: C.dim },
  body: { fontSize: 15, color: C.text, lineHeight: 21 },
  code: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, color: C.dim, backgroundColor: C.bg, padding: 8, borderRadius: 8 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  btn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 14, marginTop: 0 },
  btnText: { fontSize: 15, fontWeight: '700' },
  pill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 99 },
  pillText: { fontSize: 12, fontWeight: '700' },
  thumb: { width: '100%', aspectRatio: 16 / 9, borderRadius: 12, backgroundColor: C.bg, marginTop: 4 },
  play: { position: 'absolute', bottom: 8, left: 8, backgroundColor: 'rgba(255,255,255,0.9)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, fontSize: 12, fontWeight: '700', color: C.text, overflow: 'hidden' },
  empty: { alignItems: 'center', padding: 40, gap: 6 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: C.text },
  emptyText: { fontSize: 14, color: C.dim, textAlign: 'center' },
  errorBar: { backgroundColor: C.pink, borderRadius: 12, padding: 12, marginBottom: 10 },
  errorText: { color: C.pinkInk, fontSize: 14 },
  connect: { padding: 22, paddingTop: 50, gap: 12 },
  logo: { width: 72, height: 72, borderRadius: 20, backgroundColor: C.lilac, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  logoText: { fontSize: 36, fontWeight: '800', color: C.lilacInk },
  title: { fontSize: 30, fontWeight: '800', textAlign: 'center', color: C.text },
  lead: { fontSize: 15, color: C.dim, textAlign: 'center', lineHeight: 21, marginBottom: 6 },
  lead2: { fontSize: 14, color: C.dim, marginBottom: 10 },
  step: { fontSize: 15, color: C.text, lineHeight: 21 },
  label: { fontSize: 13, fontWeight: '700', color: C.dim },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 12, fontSize: 15, color: C.text, backgroundColor: '#fff', marginBottom: 6 },
  scanHint: { position: 'absolute', left: 20, right: 20, bottom: 40, backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 16, padding: 14, gap: 8 },
  scanHintText: { fontSize: 14, color: C.text, textAlign: 'center' },
  threadHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderColor: C.line, backgroundColor: C.card },
  threadTitle: { fontSize: 17, fontWeight: '700', color: C.text, flex: 1 },
  back: { fontSize: 16, color: C.blueInk, fontWeight: '600', marginBottom: 6 },
  bubble: { maxWidth: '86%', padding: 10, borderRadius: 14, marginBottom: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: C.blue },
  theirs: { alignSelf: 'flex-start', backgroundColor: C.card, borderWidth: 1, borderColor: C.line },
  note: { alignSelf: 'center', backgroundColor: C.amber },
  bubbleText: { fontSize: 15, color: C.text, lineHeight: 20 },
  bubbleMeta: { fontSize: 11, color: C.dim, marginTop: 3 },
  composer: { flexDirection: 'row', gap: 8, padding: 10, borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card, alignItems: 'flex-end' },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 17, fontWeight: '800', color: C.text },
  rank: { fontSize: 15, fontWeight: '800', color: C.dim, width: 36 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  stat: { flexGrow: 1, flexBasis: '45%', backgroundColor: C.card, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: C.line },
  statValue: { fontSize: 22, fontWeight: '800', color: C.text },
  statLabel: { fontSize: 12, color: C.dim, marginTop: 2 },
  section: { fontSize: 13, fontWeight: '800', color: C.dim, textTransform: 'uppercase', marginTop: 10, marginBottom: 8 },
  suggest: { backgroundColor: C.lilac, borderRadius: 99, paddingHorizontal: 14, paddingVertical: 8, alignSelf: 'flex-start', marginBottom: 8 },
  suggestText: { color: C.lilacInk, fontWeight: '600', fontSize: 13 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card, paddingTop: 6, paddingBottom: 4 },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  tabIcon: { width: 40, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  tabIconText: { fontSize: 16, color: C.dim },
  tabLabel: { fontSize: 10, color: C.dim },
});
