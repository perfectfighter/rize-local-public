// Signing and publishing are an explicit release operation, separate from the
// unsigned installer build used by ordinary CI. Secrets never enter source.
if (process.platform !== 'win32') throw new Error('Create signed releases on Windows.');
for (const key of ['WIN_PUBLISHER_NAME', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'GH_TOKEN']) {
  if (!process.env[key]) throw new Error(`Configure ${key} before publishing a signed release.`);
}
const publisher = process.env.WIN_PUBLISHER_NAME;
if (!publisher.trim() || /[\r\n]/.test(publisher)) throw new Error('WIN_PUBLISHER_NAME must match the certificate subject.');
const builder = await import('electron-builder');
await builder.build({ targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64),
  publish: 'always', config: { forceCodeSigning: true, win: { publisherName: [publisher] } } });
