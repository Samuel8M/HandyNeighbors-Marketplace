'use strict';

// One-off script: generates the Android TWA project + signing keystore
// from twa-manifest.json, without going through Bubblewrap's interactive
// CLI wizard (which has no non-interactive/scripted mode). Not meant to
// be run again once the project exists — re-running createSigningKey
// would refuse to overwrite an existing keystore, which is correct: the
// whole point of a release key is that it never changes.

const path = require('path');
const fs = require('fs');
const { TwaManifest, TwaGenerator, JdkHelper, KeyTool, ConsoleLog } = require('@bubblewrap/core');

const TARGET_DIR = __dirname;
const CONFIG_PATH = 'C:\\Users\\Samuel\\.bubblewrap\\config.json';

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const twaManifest = await TwaManifest.fromFile(path.join(TARGET_DIR, 'twa-manifest.json'));

  const log = new ConsoleLog('generate');
  const generator = new TwaGenerator();
  await generator.createTwaProject(TARGET_DIR, twaManifest, log);
  console.log('TWA project generated.');

  const keystorePath = path.resolve(TARGET_DIR, twaManifest.signingKey.path);
  if (fs.existsSync(keystorePath)) {
    console.log('Keystore already exists, skipping creation:', keystorePath);
    return;
  }

  const password = fs.readFileSync(process.argv[2], 'utf8').trim();
  const jdkHelper = new JdkHelper(process, config);
  const keytool = new KeyTool(jdkHelper);
  await keytool.createSigningKey({
    path: keystorePath,
    alias: twaManifest.signingKey.alias,
    password,
    keypassword: password,
    fullName: 'Samuel McMillan',
    organizationalUnit: 'HandyNeighbors',
    organization: 'HandyNeighbors',
    country: 'US',
  });
  console.log('Signing keystore created:', keystorePath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
