import { homedir } from 'os';
import { join } from 'path';

const SHELL_FUNCTION = `
# Snowfort - Remote access to Claude Code sessions
claude() {
  snowfort run -- claude "$@"
}
`;

async function detectShell(): Promise<'zsh' | 'bash' | null> {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  return null;
}

function getConfigPath(shell: 'zsh' | 'bash'): string {
  const home = homedir();
  return shell === 'zsh' ? join(home, '.zshrc') : join(home, '.bashrc');
}

export async function setup(): Promise<void> {
  const shell = await detectShell();

  if (!shell) {
    console.error('Could not detect shell (expected zsh or bash)');
    console.log('\nManual setup:');
    console.log('Add this to your shell config:');
    console.log(SHELL_FUNCTION);
    return;
  }

  const configPath = getConfigPath(shell);
  console.log(`Detected shell: ${shell}`);
  console.log(`Config file: ${configPath}`);

  // Check if already configured
  const file = Bun.file(configPath);
  let content = '';

  try {
    content = await file.text();
  } catch {
    // File doesn't exist, will create
  }

  if (content.includes('snowfort run -- claude')) {
    console.log('\nSnowfort is already configured!');
    console.log('The claude() function is already in your shell config.');
    return;
  }

  // Append the function
  const newContent = content + '\n' + SHELL_FUNCTION;
  await Bun.write(configPath, newContent);

  console.log('\nSetup complete!');
  console.log(`Added claude() function to ${configPath}`);
  console.log('\nTo activate, run:');
  console.log(`  source ${configPath}`);
  console.log('\nOr restart your terminal.');
  console.log('\nThen just type "claude" to start a session with Snowfort.');
}
