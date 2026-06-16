import { globalScene } from "#app/global-scene";

// Lange Kampf-Dialoge (z.B. Community-Sprüche) in klickbare Seiten zerlegen — wie
// PokeRogues normale Rivalen-Dialoge. KURZE Texte bleiben unverändert (eine Seite →
// identischer showDialogue-Aufruf wie zuvor).
//
// Robust & ausfallsicher (metrik-unabhängig):
//  - rein zeichenbasiert, KEIN Zugriff aufs Live-Textobjekt (kein Timing-/State-Risiko),
//  - überlange "Wörter" ohne Leerzeichen werden gebrochen (sonst Overflow/leere Anzeige),
//  - der ganze Aufruf hat einen try/catch → im Zweifel Original-showDialogue (zeigt Text,
//    notfalls abgeschnitten — aber NIE gar nichts).

const MAX_CHARS_PER_PAGE = 90; // konservativ unter dem 2-Zeilen-Limit (Battle-Message maxLines:2)
const MAX_WORD = 28;           // einzelne Tokens ohne Leerzeichen hart brechen

function breakLongWord(word: string): string[] {
  const parts: string[] = [];
  let w = word;
  while (w.length > MAX_WORD) {
    parts.push(w.slice(0, MAX_WORD));
    w = w.slice(MAX_WORD);
  }
  if (w) {
    parts.push(w);
  }
  return parts;
}

// Zerlegt Text gierig in Seiten ≤ MAX_CHARS_PER_PAGE an Wortgrenzen. Respektiert "$".
export function splitDialoguePages(text: string): string[] {
  const t = (text ?? "").trim();
  if (!t) {
    return [t];
  }
  const chunks = t.includes("$") ? t.split("$").map((s) => s.trim()).filter(Boolean) : [t];
  const pages: string[] = [];
  for (const chunk of chunks) {
    const words: string[] = [];
    for (const w of chunk.split(/\s+/)) {
      if (w.length > MAX_WORD) {
        words.push(...breakLongWord(w));
      } else if (w) {
        words.push(w);
      }
    }
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length > MAX_CHARS_PER_PAGE && cur) {
        pages.push(cur);
        cur = w;
      } else {
        cur = next;
      }
    }
    if (cur) {
      pages.push(cur);
    }
  }
  return pages.length ? pages : [t];
}

// Zeigt einen (evtl. langen) Dialog seitenweise. Bei EINER Seite exakt wie bisher;
// bei mehreren Seiten blättert ein "▼"-Prompt-Klick weiter, letzte Seite ruft den
// Original-Callback. Fällt bei jedem Fehler auf den Original-showDialogue zurück.
export function showPagedDialogue(text: string, speaker: string | undefined, callback: () => void): void {
  const ui = globalScene.ui;
  try {
    const pages = splitDialoguePages(text);
    const showFrom = (i: number): void => {
      if (i >= pages.length - 1) {
        ui.showDialogue(pages[i], speaker, null, callback);
      } else {
        ui.showDialogue(pages[i], speaker, null, () => showFrom(i + 1), null, true);
      }
    };
    showFrom(0);
  } catch {
    ui.showDialogue(text, speaker, null, callback);
  }
}
