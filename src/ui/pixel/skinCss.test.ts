import { describe, expect, it } from 'vitest';
import { SKIN_RULES, skinStylesheet, spriteDeclarations } from './skinCss';
import { buildUiSprites } from './sprites';

describe('generated skin CSS', () => {
  const sprites = buildUiSprites();

  it('maps every rule to an existing sprite', () => {
    for (const [selector, name] of SKIN_RULES) expect(sprites.has(name), selector).toBe(true);
  });

  it('writes 9-slice values in art pixels scaled by --px', () => {
    const sprite = sprites.get('button.primary.idle');
    if (!sprite) throw new Error('missing');
    const css = spriteDeclarations(sprite, 'x.png');
    expect(css).toContain('border-image-slice:10 9 10 9 fill');
    expect(css).toContain('border-image-width:calc(var(--px) * 10) calc(var(--px) * 9)');
    expect(css).toContain('border-image-outset:calc(var(--px) * 3)');
  });

  it('sizes fixed sprites as backgrounds', () => {
    const sprite = sprites.get('toggle.on.idle');
    if (!sprite) throw new Error('missing');
    const css = spriteDeclarations(sprite, 'x.png');
    expect(css).toContain(`background-size:calc(var(--px) * ${sprite.bitmap.w})`);
  });

  it('builds one URL per sprite', () => {
    let calls = 0;
    skinStylesheet(sprites, () => {
      calls++;
      return 'u';
    });
    const distinct = new Set(SKIN_RULES.map(([, n]) => n)).size;
    expect(calls).toBe(distinct + 1); // + the sheen variable
  });
});
