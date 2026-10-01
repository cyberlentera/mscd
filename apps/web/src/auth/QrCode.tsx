// QR code of the TOTP enrolment (BUILD-PLAN H.6, F.5): the `qrcode` package computes the modules and the page
// draws them as one SVG path, so no markup string is injected and the code renders the same on the server (tests).
import React from 'react';
import { create } from 'qrcode';

/** Quiet zone around the symbol, in modules (the frame of the page adds white padding as well). */
const MARGIN = 2;

/** SVG path of the dark modules of the QR code of `text` (rows merged into runs) and the symbol size in modules. */
export function qrPath(text: string): { size: number; d: string } {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  const size = modules.size;
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (!modules.get(y, x)) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < size && modules.get(y, x + run)) run += 1;
      parts.push(`M${x + MARGIN} ${y + MARGIN}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return { size, d: parts.join('') };
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, d } = qrPath(text);
  const box = size + MARGIN * 2;
  return (
    <svg viewBox={`0 0 ${box} ${box}`} role="img" aria-label={label} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
      <rect width={box} height={box} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

/** The base32 secret in groups of four characters for typing (H.6). */
export function groupSecret(secret: string): string {
  return (secret.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ');
}
