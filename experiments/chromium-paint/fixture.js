let count = 0;
document.querySelector('#increment').addEventListener('click', () => {
  document.querySelector('#count').textContent = String(++count);
  document.body.classList.toggle('changed', count % 2 === 1);
  document.querySelector('#status').textContent = `Page JavaScript executed ${count} time(s)`;
});
document.documentElement.dataset.ready = 'true';
