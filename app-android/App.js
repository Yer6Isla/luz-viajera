import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Pressable, StyleSheet,
  Vibration, ScrollView, StatusBar,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { VolumeManager } from 'react-native-volume-manager';
import mqtt from '@taoqf/react-native-mqtt';

// ================== Configuración ==================
// Varios servidores públicos; si uno falla, salta al siguiente solo.
const BROKERS = [
  { protocol: 'wss', host: 'broker.emqx.io', port: 8084, path: '/mqtt' },
  { protocol: 'wss', host: 'broker.hivemq.com', port: 8884, path: '/mqtt' },
  { protocol: 'wss', host: 'test.mosquitto.org', port: 8081, path: '/mqtt' },
];
const connectMqtt = (cid) => mqtt.connect({ servers: BROKERS, path: '/mqtt', clientId: cid, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 6000 });
const MAX = 4;
const DEFAULT_PIN = '2580';
const UNLOCK_HOLD_MS = 2500;

const C = {
  bg: '#000', panel: '#111722', panel2: '#0b1018', line: '#1e2a3a',
  fg: '#e8eef7', muted: '#8aa0bd', accent: '#38e1c8', accent2: '#9b7bff',
  on: '#ffd24a', danger: '#ff5d6c', ok: '#35d07f',
};

const randRoom = () => {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
};
const buzz = (p) => { try { Vibration.vibrate(p); } catch (e) {} };
const buzzN = (n) => { const p = [0]; for (let i = 0; i < n; i++) { p.push(70); p.push(110); } buzz(p); };
const buzzErr = () => buzz([0, 25, 40, 25]);

const Store = {
  async load() { try { const r = await AsyncStorage.getItem('lv_cfg'); return r ? JSON.parse(r) : {}; } catch (e) { return {}; } },
  async save(c) { try { await AsyncStorage.setItem('lv_cfg', JSON.stringify(c)); } catch (e) {} },
};

// ================== App ==================
export default function App() {
  const [cfg, setCfg] = useState(null);
  const [view, setView] = useState('decoy');

  useEffect(() => {
    Store.load().then((c) => setCfg({ room: c.room || 'BRETXY', role: c.role || null, pin: c.pin || DEFAULT_PIN }));
  }, []);
  const update = (patch) => setCfg((p) => { const n = { ...p, ...patch }; Store.save(n); return n; });

  if (!cfg) return <View style={s.root} />;
  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      {view === 'decoy' && <Decoy cfg={cfg} onSecret={() => setView('pin')} />}
      {view === 'pin' && <PinPad correct={cfg.pin} onOk={() => setView('setup')} onCancel={() => setView('decoy')} />}
      {view === 'setup' && <Setup cfg={cfg} update={update} onMando={() => setView('mando')} onReceiver={() => setView('decoy')} onClose={() => setView('decoy')} />}
      {view === 'mando' && <MandoPanel cfg={cfg} onExit={() => setView('decoy')} />}
    </View>
  );
}

// ================== Motor del Mando (controlador) ==================
function useEngine(room, active) {
  const [seen, setSeen] = useState({});
  const [lights, setLights] = useState({});
  const [inHand, setInHand] = useState(0);
  const [dest, setDest] = useState(1);
  const [connOk, setConnOk] = useState(false);
  const cRef = useRef(null), lRef = useRef({}), sRef = useRef({}), hRef = useRef(0), dRef = useRef(1);

  const topicCmd = `bretxy/lv/${room}/cmd`;
  const topicPres = `bretxy/lv/${room}/pres`;

  useEffect(() => {
    if (!active) return;
    const cid = `lv_mando_${Math.random().toString(16).slice(2, 8)}`;
    const client = connectMqtt(cid);
    cRef.current = client;
    client.on('connect', () => { setConnOk(true); client.subscribe(topicPres); });
    client.on('reconnect', () => setConnOk(false));
    client.on('close', () => setConnOk(false));
    client.on('error', () => setConnOk(false));
    client.on('message', (t, payload) => {
      if (t !== topicPres) return;
      let m; try { m = JSON.parse(payload.toString()); } catch (e) { return; }
      sRef.current = { ...sRef.current, [m.phone]: { t: m.t || Date.now(), torch: m.torch } };
      // Apuntar solo al receptor conectado si el destino actual no lo está
      if (!sRef.current[dRef.current]) {
        for (let i = 1; i <= MAX; i++) { if (sRef.current[i]) { dRef.current = i; setDest(i); break; } }
      }
      setSeen({ ...sRef.current });
    });
    const prune = setInterval(() => {
      const now = Date.now(); let ch = false; const ns = { ...sRef.current };
      for (const k in ns) if (now - ns[k].t > 8000) { delete ns[k]; ch = true; }
      if (ch) { sRef.current = ns; setSeen({ ...ns }); }
    }, 2000);
    return () => { clearInterval(prune); try { client.end(true); } catch (e) {} };
  }, [room, active]);

  const pub = (o) => { const c = cRef.current; if (c && c.connected) c.publish(topicCmd, JSON.stringify(o)); };
  const setLit = (n, v) => { lRef.current = { ...lRef.current, [n]: v }; setLights({ ...lRef.current }); };
  const setHand = (v) => { hRef.current = Math.max(0, v); setInHand(hRef.current); };
  const chooseDest = (n) => { dRef.current = n; setDest(n); };

  const cycleDest = useCallback(() => { let n = dRef.current + 1; if (n > MAX) n = 1; chooseDest(n); buzzN(n); }, []);
  const doCatch = useCallback(() => {
    if (!lRef.current[dRef.current]) { buzzErr(); return false; }
    setLit(dRef.current, false); pub({ type: 'off', phone: dRef.current }); setHand(hRef.current + 1); buzz(35); return true;
  }, []);
  const doThrow = useCallback(() => {
    const e = lRef.current[dRef.current] ? 'merge' : 'catch';
    setLit(dRef.current, true); pub({ type: 'on', phone: dRef.current, effect: e });
    if (hRef.current > 0) setHand(hRef.current - 1); // si no tenías luz, "aparece"
    buzz(45); return true;
  }, []);
  const smartPrimary = useCallback(() => {
    if (hRef.current > 0) doThrow();
    else if (lRef.current[dRef.current]) doCatch();
    else buzzErr();
  }, [doThrow, doCatch]);
  const doSplit = useCallback(() => { if (!lRef.current[dRef.current]) { buzzErr(); return; } setHand(hRef.current + 1); buzz([0, 20, 30, 20]); }, []);
  const doMerge = useCallback(() => { if (hRef.current <= 0 || !lRef.current[dRef.current]) { buzzErr(); return; } pub({ type: 'on', phone: dRef.current, effect: 'merge' }); setHand(hRef.current - 1); buzz(45); }, []);
  const doReset = useCallback(() => { for (let i = 1; i <= MAX; i++) pub({ type: 'off', phone: i }); lRef.current = {}; setLights({}); setHand(0); buzz([0, 30, 50, 30]); }, []);

  return { seen, lights, inHand, dest, connOk, chooseDest, cycleDest, doCatch, doThrow, smartPrimary, doSplit, doMerge, doReset };
}

// ================== Control secreto por botones de volumen ==================
function useVolumeControl(enabled, onUp, onDown) {
  const upRef = useRef(onUp), downRef = useRef(onDown);
  upRef.current = onUp; downRef.current = onDown;
  useEffect(() => {
    if (!enabled) return;
    let selfChange = false; let sub = null; let alive = true;
    try { VolumeManager.showNativeVolumeUI({ enabled: false }); } catch (e) {}
    try { VolumeManager.setVolume(0.5, { showUI: false }); } catch (e) {}
    const t = setTimeout(() => {
      try {
        sub = VolumeManager.addVolumeListener((res) => {
          if (!alive) return;
          if (selfChange) { selfChange = false; return; }
          const v = res && typeof res.volume === 'number' ? res.volume : 0.5;
          if (v > 0.5) { upRef.current && upRef.current(); }
          else if (v < 0.5) { downRef.current && downRef.current(); }
          selfChange = true;
          try { VolumeManager.setVolume(0.5, { showUI: false }); } catch (e) {}
        });
      } catch (e) {}
    }, 400);
    return () => {
      alive = false; clearTimeout(t);
      try { sub && sub.remove && sub.remove(); } catch (e) {}
      try { VolumeManager.showNativeVolumeUI({ enabled: true }); } catch (e) {}
    };
  }, [enabled]);
}

// ================== Pantalla LINTERNA (señuelo + receptor + mando oculto) ==================
function Decoy({ cfg, onSecret }) {
  useKeepAwake();
  const [perm, requestPerm] = useCameraPermissions();
  const [on, setOn] = useState(false);
  const onRef = useRef(false);
  const holdTimer = useRef(null);

  const isReceiver = cfg.role && cfg.role !== 'mando';
  const isMando = cfg.role === 'mando';
  const num = isReceiver ? parseInt(cfg.role, 10) : null;

  // Si es Mando: motor + control por volumen (se maneja desde esta pantalla de linterna)
  const engine = useEngine(cfg.room, isMando);
  useVolumeControl(isMando, engine.cycleDest, engine.smartPrimary);

  const setLight = useCallback((v) => { onRef.current = v; setOn(v); }, []);
  const toggle = () => { if (perm && !perm.granted) { requestPerm(); return; } setLight(!onRef.current); };
  const flash = useCallback((times, finalOn) => {
    let i = 0; const iv = setInterval(() => { setLight(i % 2 === 0); i++; if (i >= times * 2) { clearInterval(iv); setLight(finalOn); } }, 90);
  }, [setLight]);

  // Receptor: escucha al Mando (sin que se note)
  useEffect(() => {
    if (!isReceiver) return;
    const topicCmd = `bretxy/lv/${cfg.room}/cmd`;
    const topicPres = `bretxy/lv/${cfg.room}/pres`;
    const client = connectMqtt(`lv_${num}_${Math.random().toString(16).slice(2, 8)}`);
    client.on('connect', () => { client.subscribe(topicCmd); send(); });
    client.on('message', (t, payload) => {
      if (t !== topicCmd) return;
      let m; try { m = JSON.parse(payload.toString()); } catch (e) { return; }
      if (m.phone !== num) return;
      if (m.type === 'off') setLight(false);
      else if (m.type === 'on') {
        if (m.effect === 'catch') flash(2, true);
        else if (m.effect === 'bounce') { setLight(false); setTimeout(() => flash(1, true), 120); }
        else if (m.effect === 'merge') flash(3, true);
        else setLight(true);
      }
    });
    const send = () => { if (client.connected) client.publish(topicPres, JSON.stringify({ phone: num, torch: true, lit: onRef.current, t: Date.now() })); };
    const pi = setInterval(send, 3000);
    return () => { clearInterval(pi); try { client.end(true); } catch (e) {} };
  }, [isReceiver, num, cfg.room]);

  const startHold = () => { holdTimer.current = setTimeout(onSecret, UNLOCK_HOLD_MS); };
  const endHold = () => { if (holdTimer.current) clearTimeout(holdTimer.current); };

  return (
    <View style={s.flashRoot}>
      {perm && perm.granted && <CameraView style={s.hiddenCam} facing="back" enableTorch={on} />}
      <Pressable onPressIn={startHold} onPressOut={endHold}><Text style={s.flashTitle}>Flashlight</Text></Pressable>
      <View style={s.flashCenter}>
        <TouchableOpacity activeOpacity={0.8} onPress={toggle} style={[s.powerBtn, on && s.powerBtnOn]}>
          <View style={[s.powerIcon, on && s.powerIconOn]} />
          <Text style={[s.powerLabel, on && { color: '#000' }]}>{on ? 'ON' : 'OFF'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.flashFoot}>Tap to turn the light on or off</Text>
    </View>
  );
}

// ================== PIN ==================
function PinPad({ correct, onOk, onCancel }) {
  const [val, setVal] = useState(''); const [err, setErr] = useState(false);
  const press = (d) => {
    const n = (val + d).slice(0, 6); setVal(n); setErr(false);
    if (n.length >= String(correct).length) { if (n === String(correct)) onOk(); else { setErr(true); setTimeout(() => setVal(''), 350); } }
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  return (
    <View style={s.pinRoot}>
      <Text style={s.pinTitle}>Clave</Text>
      <Text style={[s.pinDots, err && { color: C.danger }]}>{'•'.repeat(val.length) || ' '}</Text>
      <View style={s.pinGrid}>
        {keys.map((k, i) => (
          <TouchableOpacity key={i} disabled={k === ''} style={[s.pinKey, k === '' && { opacity: 0 }]}
            onPress={() => k === '⌫' ? setVal(val.slice(0, -1)) : press(k)}>
            <Text style={s.pinKeyText}>{k}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TouchableOpacity onPress={onCancel}><Text style={s.pinCancel}>Volver</Text></TouchableOpacity>
    </View>
  );
}

// ================== Setup ==================
function Setup({ cfg, update, onMando, onReceiver, onClose }) {
  const [room, setRoom] = useState(cfg.room);
  const [pin, setPin] = useState(cfg.pin);
  const saveRoom = (t) => { const v = t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); setRoom(v); update({ room: v }); };
  const chooseRole = (r) => { update({ role: r, room }); r === 'mando' ? onMando() : onReceiver(); };
  return (
    <ScrollView contentContainerStyle={s.setupWrap}>
      <Text style={s.h1}>Panel</Text>
      <Text style={s.sub}>Configuración del truco · solo tú ves esto</Text>
      <Text style={s.label}>Código de sala (igual en todos)</Text>
      <TextInput style={s.input} value={room} onChangeText={saveRoom} autoCapitalize="characters" maxLength={6} />
      <Text style={s.label}>Este celular será…</Text>
      <TouchableOpacity style={[s.btn, s.violet]} onPress={() => chooseRole('mando')}><Text style={s.btnText}>🎛️ Mando (control)</Text></TouchableOpacity>
      <View style={s.roleRow}>
        {[1, 2, 3, 4].map((n) => (
          <TouchableOpacity key={n} style={[s.btn, s.roleBtn, String(cfg.role) === String(n) && s.roleBtnSel]} onPress={() => chooseRole(n)}>
            <Text style={s.btnText}>Receptor {n}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={s.label}>Tu PIN secreto</Text>
      <TextInput style={s.input} value={pin} onChangeText={(t) => setPin(t.replace(/[^0-9]/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} />
      <TouchableOpacity style={[s.btn, { marginTop: 8 }]} onPress={() => update({ pin: pin || DEFAULT_PIN })}><Text style={s.btnText}>Guardar PIN</Text></TouchableOpacity>
      <TouchableOpacity style={[s.btn, s.danger, { marginTop: 16 }]} onPress={onClose}><Text style={s.btnText}>Salir (volver a linterna)</Text></TouchableOpacity>
      <Text style={s.foot}>
        En el Mando controlas a escondidas con los botones de VOLUMEN (o un mando Bluetooth):{"\n"}
        Volumen + = cambiar destino (vibra el número) · Volumen − = agarrar / lanzar.{"\n"}
        Para abrir este panel: mantén pulsado “Flashlight” 2,5 s y teclea tu PIN.
      </Text>
    </ScrollView>
  );
}

// ================== Mando (panel visible: ensayo / manual) ==================
function MandoPanel({ cfg, onExit }) {
  useKeepAwake();
  const e = useEngine(cfg.room, true);
  useVolumeControl(true, e.cycleDest, e.smartPrimary);
  return (
    <ScrollView contentContainerStyle={s.mandoWrap}>
      <View style={s.mandoHead}>
        <Text style={s.h1b}>Mando</Text>
        <View style={s.statusLine}><View style={[s.dot, { backgroundColor: e.connOk ? C.ok : C.danger }]} /><Text style={s.statusText}>{e.connOk ? 'En línea' : 'Conectando…'}</Text></View>
      </View>
      <View style={s.roster}>
        {[1, 2, 3, 4].map((i) => {
          const on = !!e.seen[i]; const lit = !!e.lights[i];
          return (
            <View key={i} style={[s.cell, !on && s.cellOff, lit && s.cellLit]}>
              <Text style={[s.cellN, lit && { color: C.on }]}>{i}</Text>
              <Text style={s.cellMeta}>{on ? '🔦 lista' : 'off'}</Text>
            </View>
          );
        })}
      </View>
      <View style={[s.hand, e.inHand > 0 && { borderColor: C.accent, borderStyle: 'solid' }]}>
        <Text style={s.handText}>Luz en la mano: </Text><Text style={s.handNum}>{e.inHand}</Text>
      </View>
      <View style={s.destRow}>
        <Text style={s.lbl}>DESTINO</Text>
        {[1, 2, 3, 4].map((i) => (
          <TouchableOpacity key={i} style={[s.dpill, e.dest === i && s.dpillSel]} onPress={() => { e.chooseDest(i); buzz(15); }}>
            <Text style={[s.dpillText, e.dest === i && { color: '#042' }]}>{i}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={s.actions}>
        <TouchableOpacity style={[s.btn, s.primary, s.actBtn]} onPress={e.doCatch}><Text style={s.btnTextDark}>✋ Agarrar</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.violet, s.actBtn]} onPress={e.doThrow}><Text style={s.btnText}>➤ Lanzar</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.actBtn]} onPress={e.doSplit}><Text style={s.btnText}>⚡ Dividir</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.actBtn]} onPress={e.doMerge}><Text style={s.btnText}>⊙ Juntar</Text></TouchableOpacity>
      </View>
      <Text style={s.hint}>Volumen +: destino · Volumen −: agarrar/lanzar (también sirve un mando Bluetooth)</Text>
      <View style={s.mini}>
        <TouchableOpacity style={[s.btn]} onPress={e.doReset}><Text style={s.btnText}>↺ Reiniciar</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.danger]} onPress={onExit}><Text style={s.btnText}>Ocultar</Text></TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ================== Estilos ==================
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  h1: { color: C.fg, fontSize: 28, fontWeight: '800' },
  h1b: { color: C.fg, fontSize: 22, fontWeight: '800' },
  sub: { color: C.muted, fontSize: 13, marginBottom: 16, marginTop: 2 },
  label: { color: C.muted, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 6 },
  input: { backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, color: C.fg, fontSize: 22, letterSpacing: 4, textAlign: 'center', padding: 14, borderRadius: 14 },
  btn: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 15, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: C.fg, fontSize: 16, fontWeight: '700' },
  btnTextDark: { color: '#042', fontSize: 16, fontWeight: '800' },
  violet: { backgroundColor: C.accent2, borderColor: C.accent2, marginTop: 6 },
  primary: { backgroundColor: C.accent, borderColor: C.accent },
  danger: { backgroundColor: 'transparent', borderColor: C.danger },
  roleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  roleBtn: { flexGrow: 1, flexBasis: '45%' },
  roleBtnSel: { borderColor: C.accent, borderWidth: 2 },
  foot: { color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 16, lineHeight: 18 },
  flashRoot: { flex: 1, backgroundColor: '#000', alignItems: 'center', paddingTop: 60, paddingBottom: 40 },
  flashTitle: { color: '#777', fontSize: 16, fontWeight: '600', letterSpacing: 1 },
  flashCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  powerBtn: { width: 190, height: 190, borderRadius: 95, backgroundColor: '#141414', borderWidth: 2, borderColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center' },
  powerBtnOn: { backgroundColor: C.on, borderColor: '#fff' },
  powerIcon: { width: 14, height: 46, borderRadius: 7, backgroundColor: '#555', marginBottom: 10 },
  powerIconOn: { backgroundColor: '#000' },
  powerLabel: { color: '#666', fontSize: 20, fontWeight: '800', letterSpacing: 2 },
  flashFoot: { color: '#444', fontSize: 13 },
  pinRoot: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 30 },
  pinTitle: { color: C.muted, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 10 },
  pinDots: { color: C.fg, fontSize: 40, letterSpacing: 10, height: 56, marginBottom: 20 },
  pinGrid: { width: 260, flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'center' },
  pinKey: { width: 70, height: 70, borderRadius: 35, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  pinKeyText: { color: C.fg, fontSize: 26, fontWeight: '600' },
  pinCancel: { color: C.muted, fontSize: 15, marginTop: 24 },
  mandoWrap: { padding: 18, paddingTop: 50, flexGrow: 1 },
  mandoHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  statusLine: { flexDirection: 'row', alignItems: 'center' },
  statusText: { color: C.muted, fontSize: 13 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 6, backgroundColor: C.muted },
  roster: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  cell: { backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingVertical: 12, flexGrow: 1, flexBasis: '22%', alignItems: 'center' },
  cellOff: { opacity: 0.35 }, cellLit: { borderColor: C.on }, cellDest: { borderColor: C.accent, borderWidth: 2 },
  cellN: { color: C.fg, fontSize: 22, fontWeight: '800' },
  cellMeta: { color: C.muted, fontSize: 10, marginTop: 2 },
  hand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderStyle: 'dashed', borderRadius: 14, padding: 14, marginBottom: 12 },
  handText: { color: C.fg, fontSize: 15 }, handNum: { color: C.accent, fontSize: 20, fontWeight: '800' },
  destRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  lbl: { color: C.muted, fontSize: 11, letterSpacing: 1 },
  dpill: { flexGrow: 1, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  dpillSel: { backgroundColor: C.accent, borderColor: C.accent },
  dpillText: { color: C.fg, fontSize: 16, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  actBtn: { flexGrow: 1, flexBasis: '45%', paddingVertical: 20 },
  hint: { color: C.muted, fontSize: 12, textAlign: 'center', marginBottom: 10 },
  mini: { flexDirection: 'row', gap: 10 },
  hiddenCam: { width: 1, height: 1, opacity: 0, position: 'absolute' },
});
