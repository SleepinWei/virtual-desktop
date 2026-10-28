let count = Number(localStorage.getItem('native-count') || 0), tick = 0, timer;
const $ = selector => document.querySelector(selector);
$('#count').textContent = String(count);
$('#increment').addEventListener('click', () => {
  $('#count').textContent = String(++count); localStorage.setItem('native-count', String(count));
});
$('#message').addEventListener('input', () => { $('#echo').textContent = $('#message').value || 'Input is empty'; });
$('#animate').addEventListener('click', () => {
  if (timer) { clearInterval(timer); timer = null; $('#animate').textContent = 'Start updates'; return; }
  $('#animate').textContent = 'Stop updates';
  timer = setInterval(() => {
    $('#tick').textContent = String(++tick);
    $('#pulse').style.transform = `translate(${tick % 2 ? 16 : 0}px, 0)`;
    $('#pulse').style.backgroundColor = tick % 2 ? '#16875c' : '#2b68ca';
  }, 200);
});
for (let index = 0; index < 16; index++) {
  const row = document.createElement('div'); row.className = 'row'; row.textContent = `Native row ${String(index).padStart(2, '0')}`; $('#rows').append(row);
}
