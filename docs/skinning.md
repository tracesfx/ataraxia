# Skinning

**Skins are deferred.** There is no skin loading, skin import or skin setting; Phase 14 was
skipped. Only the built-in default look exists.

What remains is an internal interface the gameplay renderer draws through: `Skin` in
`src/render/skin.ts`. The renderer (`src/render/gameRenderer.ts`) only blits what it provides:

- `colors`: text, shadow, outline, judgement ramps (metallic), early / late, combo tier ramps,
  the broken-combo ramp, rainbow hues, the combo shine and sparkles, lane glow per hue, the HUD panel, loop
  marker, background.
- `sprites` at fixed logical sizes (`src/render/fieldLayout.ts`): notes per hue (`outer` for
  lanes 0 and 3, `inner` for 1 and 2), hold bodies and caps, progress bar track and fill.
  (Receptors, key beams and hit effect frames were removed in Phase 22.)
- `fonts`: Jersey 10 glyph atlases (`src/render/glyphAtlas.ts`): the 1x label atlas (also drawn
  at whole multiples for the score, accuracy, combo and judgements), a 2x atlas and the timing
  particles.
- `buildField(layout)`: the static field art (glass, translucent below the hit line, dividers,
  rails, the judgement line).
- `createBackground()`: the static gradient, the fallback layer behind the field. The animated
  backgrounds (`docs/backgrounds.md`) replace it during play and fall back to it.

The default implementation is `src/skins/default`: every sprite is generated at startup from the
theme tokens (`src/ui/theme.ts`) as palette-only bitmaps (`sprites.ts`, tested). New sprites: add
the field to `SkinSprites`, generate it in `src/skins/default/sprites.ts` with a size and palette
test, and list it here.
