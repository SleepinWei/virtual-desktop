export function leanTask(task = 'build') {
  const tasks = {
    build: { script: 'lean-build.py', phase: 'build', state: 'virtual-desktop-lean-ninja-build-state.json', success: 'compiled-candidate' },
    'cpp-build': { script: 'lean-tests.py', phase: 'build', state: 'virtual-desktop-lean-tests-state.json', success: 'compiled-candidate' },
    'cpp-test': { script: 'lean-tests.py', phase: 'test', state: 'virtual-desktop-lean-tests-state.json', success: 'cpp-tests-passed' },
  };
  if (!Object.hasOwn(tasks, task)) throw new Error('Unknown lean build task: ' + task);
  return tasks[task];
}
