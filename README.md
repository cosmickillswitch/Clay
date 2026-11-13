# Clayframe

Sculpt, rig and animate 3D characters in the browser, then puppet them live. It's a home-screen web app with no build step, and it works offline once loaded.

## Modes
- **Sculpt**: Clay, Draw, Inflate, Smooth, Flatten, Pinch, Crease, Move, Mask and Paint. Size and strength are on the left sliders, ⇋ X mirrors, and − Sub inverts. Subdivide adds detail. One finger sculpts and two fingers orbit, pan and zoom.
- **Objects**: add primitives or import an OBJ. Drag an object to move it, or use the arrows (move along an axis), rings (turn) and outer circle (size). Look sets colour and material (matcaps), Shapes holds sculpted shape keys, and Parent attaches an object to another object or to one of its bones.
- **Rig**: tap inside a limb to drop joints; each tap after the first adds a bone. With ⇋ X on, arms and legs are mirrored. Drag joints to adjust them. Bind (or leaving Rig) works out the skin weights automatically.
- **Pose**: drag a joint to pose it. With IK on, the bones above it bend too (Chain sets how many). The rings turn the selected bone.
- **Stage**: puppet a character with a game controller (Gamepad API) or the on-screen sticks, triggers and A button. Record plays the timeline and writes what you did as keyframes, so you can layer takes. ⚙ Controls changes what each input does.

## Animation
- ◇ keyframes the selection at the playhead. ● auto-key keyframes every change.
- Tap a ◆ on the timeline to jump to it, tap it again to set its easing, or drag it to retime.
- 🎥◆ keyframes the camera view, and 🎥 plays through the camera keys.
- Export records a video (through the camera keys if there are any) or saves the selected object as an OBJ as posed.

## Files
- `math.js`: vectors, quaternions, matrices, easing.
- `mesh.js`: meshes, primitives, subdivision, ray casting, OBJ.
- `sculpt.js`: brushes.
- `scene.js`: keyframes, bones, skinning weights, IK, shape keys, camera track.
- `render.js`: WebGL2 renderer with matcaps and GPU skinning.
- `app.js`: the editor.
- Projects are stored in IndexedDB on the device. ⋯ → Save a backup file moves a project between devices.
- When you change files, bump `VERSION` in `sw.js` so installed copies update.
