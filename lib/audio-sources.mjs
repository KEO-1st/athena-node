/**
 * Audio source classification.
 *
 * "Listen" has two different meanings on a Windows node:
 *   microphone — what the room/headset mic hears;
 *   desktop    — what the PC itself is playing, via Stereo Mix, a virtual
 *                cable or another loopback capture device.
 *
 * Windows exposes both through DirectShow. Guessing the first device was why
 * the old LISTEN button could quietly stream the microphone when the user
 * expected the PC's sound. Classification is shared with tests so the two
 * controls cannot drift apart.
 */

const DESKTOP = /stereo mix|what u hear|virtual-audio-capturer|vb-audio|cable output|loopback|wave out mix|speaker mix/i;
const MICROPHONE = /microphone|mic\b|headset|array|webcam|line in/i;

export function classifyAudioDevices(devices = []) {
  const list = [...new Set((Array.isArray(devices) ? devices : []).map((name) => String(name || "").trim()).filter(Boolean))];
  const desktop = list.filter((name) => DESKTOP.test(name));
  const microphone = list.filter((name) => !DESKTOP.test(name) && MICROPHONE.test(name));
  return {
    all: list,
    desktop,
    microphone,
    systemAudio: desktop.length > 0,
    microphoneAudio: microphone.length > 0,
  };
}

/**
 * Choose a device for a source. Return null when the source genuinely is not
 * available — never fall back from desktop to microphone, because that would
 * stream the wrong thing without telling the user.
 */
export function pickAudioDevice(inventory, source = "desktop") {
  const wanted = source === "microphone" ? inventory?.microphone : inventory?.desktop;
  return Array.isArray(wanted) && wanted.length ? wanted[0] : null;
}

/** An explicitly requested device must belong to the requested source. */
export function audioDeviceBelongsToSource(inventory, source = "desktop", device = "") {
  const wanted = source === "microphone" ? inventory?.microphone : inventory?.desktop;
  return Array.isArray(wanted) && wanted.includes(String(device || "").trim());
}
