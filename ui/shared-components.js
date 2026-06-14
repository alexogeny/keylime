(() => {
  const frame = (src, title) => `<iframe title="${title}" src="${src}" class="kl-frame"></iframe>`;
  const statusColor = (state) => ({ idle: '#6a655c', thinking: '#b3c46e', planning: '#c9a86a', researching: '#9a93b4', reading: '#7fa6b0', writing: '#82a98c', tooling: '#7fa6b0', error: '#c5897a', done: '#82a98c' }[state] || '#9c968a');
  window.KeylimeComponents = { frame, statusColor };
})();
