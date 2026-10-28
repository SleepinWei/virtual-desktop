const phases = ['before', 'changed', 'scrolled', 'removed'];
for (let index = 0; index < 16; index++) {
  const row = document.createElement('div');
  row.className = 'row'; row.textContent = `Native row ${String(index).padStart(2, '0')}`;
  document.querySelector('#rows').append(row);
}
let phase = 0;
document.querySelector('#advance').addEventListener('click', () => {
  phase = Math.min(phase + 1, phases.length - 1);
  document.body.classList.add('changed');
  if (phases[phase] === 'removed') document.querySelector('#removable')?.remove();
  document.querySelector('#phase').textContent = phases[phase];
});
