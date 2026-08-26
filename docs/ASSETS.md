# Asset attribution and release notes

## Chopper pet

- Creator: `mrkblckwd`
- Source: [Tony Tony Chopper on Sketchfab](https://sketchfab.com/3d-models/tony-tony-chopper-50703f2f23064436ab8c2a7aad4fdd25)
- Listed license: Creative Commons Attribution (CC BY)
- Intended local path: `web/assets/chopper.glb`

The Sketchfab page requires authentication for model downloads. The project does
not bypass that access control. Place the creator-provided downloaded GLB at
`web/assets/chopper.glb`; the game will inspect and load it when available and
use a safe capsule fallback when it is missing or fails to load.

The CC license is recorded here as covering the creator's model contribution
only. The character is fan art of Tony Tony Chopper / One Piece, so the
underlying One Piece and Chopper intellectual-property rights are a separate
public-release legal risk. Obtain appropriate permission or replace the asset
before public distribution.

At runtime the loader reports texture embedding, skeleton/bone count,
animation names, triangle count, dimensions, and the calibrated forward-axis
transform in the in-game system log and `window.__petDiagnostics`. Until the GLB is present,
those asset-specific checks cannot be completed.
