// A local, invisible text sink lets the OS compose text at the click location.
// Only committed text is forwarded; the remote page remains the real editor.
export function captureNativeInput({ canvas, sink, enabled, send, leave, onError }) {
  let composing = false;
  const focus = event => {
    if (!enabled()) return;
    const bounds = canvas.getBoundingClientRect();
    sink.style.left = `${event ? event.clientX - bounds.left : 16}px`;
    sink.style.top = `${event ? event.clientY - bounds.top : 16}px`;
    sink.focus({ preventScroll: true });
  };
  canvas.addEventListener('focus', () => focus());
  canvas.addEventListener('click', focus);
  const commit = value => {
    if (!enabled() || !value) return;
    if (value.length > 128000) { onError?.('Pasted text is too large. Send at most 128,000 characters at a time.'); return; }
    // Keep complete Unicode code points when splitting long clipboard text.
    let chunk = '';
    for (const character of value) {
      if (chunk.length + character.length > 2000) { send({ type: 'text', value: chunk }); chunk = ''; }
      chunk += character;
    }
    if (chunk) send({ type: 'text', value: chunk });
  };
  sink.addEventListener('compositionstart', () => { composing = true; });
  sink.addEventListener('compositionend', event => {
    composing = false; commit(event.data || sink.value); sink.value = '';
  });
  sink.addEventListener('input', event => {
    if (composing || event.isComposing) return;
    commit(sink.value); sink.value = '';
  });
  sink.addEventListener('paste', event => {
    if (!enabled() || composing) return;
    event.preventDefault(); commit(event.clipboardData.getData('text/plain')); sink.value = '';
  });
  sink.addEventListener('beforeinput', event => {
    if (!enabled() || composing || event.isComposing) return;
    const key = { deleteContentBackward: 'Backspace', deleteContentForward: 'Delete', insertLineBreak: 'Enter', insertParagraph: 'Enter' }[event.inputType];
    if (key) { event.preventDefault(); send({ type: 'key', key }); }
  });
  sink.addEventListener('keydown', event => {
    if (!enabled() || composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); sink.blur(); leave(); return; }
    const shortcut = (event.ctrlKey || event.metaKey) && /^[azy]$/i.test(event.key);
    const special = ['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key);
    if (!shortcut && !special) return;
    event.preventDefault();
    const modifiers = [['Shift', event.shiftKey], ['Control', event.ctrlKey], ['Alt', event.altKey], ['Meta', event.metaKey]]
      .filter(([, pressed]) => pressed).map(([name]) => name);
    send({ type: 'key', key: shortcut ? event.key.toUpperCase() : event.key, modifiers });
  });
  return { reset() { composing = false; sink.value = ''; sink.blur(); } };
}
