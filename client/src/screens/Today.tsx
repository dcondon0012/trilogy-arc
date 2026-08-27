import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { todayISO } from '../types';

interface DeckAction { label: string; method: string; path: string; body?: any; then?: { method: string; path: string }; style?: string; }
interface DeckCard {
  id: string; type: string; stripe: string; actor: string; title: string; sub: string;
  patientId: string | null; patientName: string; outcome: string; recommend: string;
  tiles: { v: string; l: string }[]; actions: DeckAction[]; chips: string[]; age: string | null;
}

export function Today() {
  const { boot, go } = useApp();
  const [deck, setDeck] = useState<any>(null);
  const [idx, setIdx] = useState(0);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);

  const load = () => api('GET', '/deck').then((d: any) => { setDeck(d); setIdx(i => Math.min(i, Math.max(0, d.cards.length - 1))); });
  useEffect(() => { load(); }, []);

  const cards: DeckCard[] = deck?.cards || [];
  const card = cards[idx];

  const run = useCallback(async (a: DeckAction) => {
    if (!card || busy) return;
    try {
      setBusy(true);
      if (a.method === 'PROMPT-VOID') {
        const reason = prompt('Void — reason (required, permanent record):');
        if (!reason?.trim()) return;
        await api('POST', a.path, { reason });
      } else if (a.method === 'PROMPT-SNOOZE') {
        const due = prompt('Push out to (YYYY-MM-DD):', todayISO());
        if (!due) return;
        await api('POST', a.path, { due });
      } else {
        await api(a.method, a.path, a.body);
        if (a.then) await api(a.then.method, a.then.path).catch(() => {});
      }
      setDone(d => d + 1);
      await load();
    } catch (e: any) { alert(e.message || 'Error'); } finally { setBusy(false); }
  }, [card, busy]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowDown' || e.key === 'j') setIdx(i => Math.min(i + 1, cards.length - 1));
      if (e.key === 'ArrowUp' || e.key === 'k') setIdx(i => Math.max(i - 1, 0));
      if ((e.key === 'a' || e.key === 'A') && card?.actions?.[0]) run(card.actions[0]);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [cards.length, card, run]);

  if (!deck) return null;
  const o = deck.outcomes;
  const first = boot.user.name.split(' ')[0];
  const hour = new Date().getHours();

  return (
    <div>
      <div className="home-hero" style={{ marginBottom: 14 }}>
        <h1>Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {first}</h1>
        <p>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · <b style={{ color: 'var(--ink)' }}>{cards.length} thing{cards.length === 1 ? '' : 's'} on your plate</b>{done > 0 && <span style={{ color: 'var(--green-dark)' }}> · {done} cleared this session</span>}</p>
      </div>

      <div className="receipts">
        <span className="zap">⚡</span> While you were away, the system logged <b>{deck.receipts.total} actions</b>
        {deck.receipts.items.length > 0 && <> — {deck.receipts.items.slice(0, 3).map((r: any) => `${r.what} ×${r.n}`).join(' · ')}</>}
        {' '}<span className="link" style={{ color: '#8FC7EF' }} onClick={() => setReceiptsOpen(v => !v)}>{receiptsOpen ? 'hide' : 'see the log →'}</span>
        {receiptsOpen && (
          <div style={{ marginTop: 10, fontSize: 12.5, display: 'grid', gap: 3 }}>
            {deck.receipts.items.map((r: any, i: number) => <div key={i}><span className="mono" style={{ color: '#8FC7EF' }}>×{r.n}</span> {r.what}</div>)}
          </div>)}
      </div>

      <div className="outcomes">
        <div className="outcome" style={{ borderLeftColor: 'var(--green)' }}><div className="on serif">{o.readyToClose}</div><div className="ol">cases done treating — ready to close out</div></div>
        <div className="outcome" style={{ borderLeftColor: 'var(--amber)' }}><div className="on serif">{o.notInCare}</div><div className="ol">claimants not yet in care — speed risk</div></div>
        <div className="outcome" style={{ borderLeftColor: 'var(--red)' }}><div className="on serif">{o.costRisk}</div><div className="ol">cases trending against coverage — cost risk</div></div>
        <div className="outcome" style={{ borderLeftColor: 'var(--blue)' }}><div className="on serif">{o.readyToPay}</div><div className="ol">clean bills ready to pay at contract</div></div>
        <div className="outcome" style={{ borderLeftColor: 'var(--red)' }}><div className="on serif">{o.attorneyRisk}</div><div className="ol">attorney flags — thesis watch</div></div>
      </div>

      {cards.length === 0 ? (
        <div className="card" style={{ padding: 28, textAlign: 'center' }}>
          <div className="serif" style={{ fontSize: 22, marginBottom: 6 }}>Deck clear. 🎉</div>
          <div style={{ color: 'var(--ink-soft)', marginBottom: 18 }}>Nothing needs your judgment right now — here's how to get ahead:</div>
          <div className="grid2" style={{ textAlign: 'left', maxWidth: 640, margin: '0 auto' }}>
            {deck.aboveBeyond.map((ab: any, i: number) => (
              <div key={i} className="card" style={{ boxShadow: 'none' }}><div className="cbody">
                <b>⤴ {ab.title}</b><div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 3 }}>{ab.why}</div>
              </div></div>))}
          </div>
        </div>
      ) : (
        <>
          <div className="dk-nav">
            <span className="eyebrow">Decisions waiting on your judgment</span>
            <span className="dk-count mono">card {idx + 1} of {cards.length}</span>
            <span className="dk-keys">navigate <kbd>↑</kbd><kbd>↓</kbd> or <kbd>J</kbd><kbd>K</kbd> · <kbd>A</kbd> approve</span>
          </div>
          {card && (
            <div className="deck-card">
              <div className={'stripe st-' + card.stripe} />
              <div className="dk-head">
                <span className={'actor ' + (card.type.startsWith('⚡') ? 'sys' : card.type.startsWith('↪') ? 'handed' : 'you')}>{card.type}</span>
                <span className="dk-age mono">{card.age ? 'since ' + card.age : ''}</span>
              </div>
              <div className="dk-title serif">{card.title}</div>
              <div className="dk-sub">
                {card.patientId && <span className="link" onClick={() => go({ screen: 'patient', id: card.patientId! })}>{card.patientName}</span>}
                {card.patientId && card.sub ? ' · ' : ''}{card.sub}
              </div>
              <div className="dk-outcome">{card.outcome}</div>
              <div className="dk-rec"><b>⚡ System recommends:</b> {card.recommend}</div>
              <div className="dk-tiles">
                {card.tiles.map((t, i) => <div key={i} className="dk-tile"><div className="tv mono">{t.v}</div><div className="tl">{t.l}</div></div>)}
              </div>
              <div className="dk-actions">
                {card.actions.map((a, i) => (
                  <button key={i} className={'btn ' + (a.style === 'primary' ? 'accent' : '')} disabled={busy} onClick={() => run(a)}>{a.label}</button>))}
                <button className="btn" onClick={() => setIdx(i => Math.min(i + 1, cards.length - 1))}>Skip →</button>
              </div>
              {(card.chips.length > 0 || card.patientId) && (
                <div className="dk-chips">
                  <span style={{ fontSize: 11, color: 'var(--ink-mute)', padding: '4px 0' }}>Do something else:</span>
                  {card.patientId && <span className="dk-chip" onClick={() => go({ screen: 'patient', id: card.patientId! })}>Open the full case</span>}
                  {card.chips.filter(c => c !== 'Open the case').map((c, i) => <span key={i} className="dk-chip" onClick={() => card.patientId && go({ screen: 'patient', id: card.patientId! })}>{c}</span>)}
                </div>)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
            {cards.map((c, i) => (
              <span key={c.id} onClick={() => setIdx(i)} title={c.title}
                style={{ width: 22, height: 5, borderRadius: 3, cursor: 'pointer', background: i === idx ? 'var(--slate)' : c.stripe === 'red' ? 'var(--red)' : c.stripe === 'amber' ? 'var(--amber)' : 'var(--line)' , opacity: i === idx ? 1 : .6 }} />))}
          </div>
        </>
      )}
    </div>
  );
}
