// English translations
export default {
  // ── App title ──────────────────────────────────────────
  title: 'SlimeNRF OTA Updater',

  dev: {
    title: 'Developer mode enabled',
    warning: 'Board and role validation is disabled. Any loaded firmware can be mapped or flashed to any target.',
  },

  // ── WebHID not supported ──────────────────────────────
  webhid: {
    notSupported: 'WebHID not supported',
    useChrome: 'Please use {chrome}, {edge}, or {opera} to access WebHID.',
    serialAvailable: 'WebHID OTA is unavailable, but you can use Serial DFU below.',
  },

  // ── Connection card ────────────────────────────────────
  conn: {
    title: 'Connection',
    rescan: 'Rescan',
    disconnect: 'Disconnect',
    addDevice: 'Add Device',
    pairedDevices: 'Previously paired devices:',
    switchReceiver: 'Switch receiver ({count} paired)',
    trackers: 'trackers',
  },

  // ── OTA notice ─────────────────────────────────────────
  notice: {
    otaRequires: 'OTA requires compatible tracker firmware from {tracker} and receiver firmware from {receiver}. Please flash via USB/UF2 first if needed.',
  },

  // ── Receiver card ──────────────────────────────────────
  receiver: {
    title: 'Receiver',
    selfOtaUnsupported: 'Self-OTA unsupported',
    noResponse: 'No response',
    noResponseHint: 'Try refreshing — may need UF2/DFU flash if firmware is outdated',
    querying: 'Querying…',
    enterDfu: 'Enter DFU',
    enterDfuTitle: 'Send DFU command via serial to enter bootloader mode',
    refresh: 'Refresh',
  },

  // ── Tracker card ───────────────────────────────────────
  tracker: {
    title: 'Trackers',
    online: 'online',
    offline: 'offline',
    selectAll: 'Select All',
    deselect: 'Deselect',
    refreshInfo: 'Refresh info',
    otaUnsupported: 'OTA Unsupported',
    flashFirst: 'Flash via UF2/DFU first',
    scanning: 'Scanning for trackers…',
  },

  // ── GitHub downloads ───────────────────────────────────
  gh: {
    title: 'Download Firmwares from GitHub',
    releases: 'Releases',
    trackerCi: 'Tracker CI (all branches)',
    receiverCi: 'Receiver CI (all branches)',
    onlyMatched: 'Only Matched',
    selectCiBuild: '— Select a CI build —',
    selectReceiverCiBuild: '— Select a receiver CI build —',
    artifactsShown: 'artifact(s) shown',
    firmwaresShown: 'firmware(s) shown',
    opensInTab: 'Opens in new tab (drop .zip to load)',
    releasesOpensInTab: 'Opens in new tab',
    loadingArtifacts: 'Loading artifacts…',
    noReleases: 'No releases found',
    noCiBuilds: 'No tracker CI builds found',
    noReceiverCiBuilds: 'No receiver CI builds found',
    noArtifacts: 'No artifacts found for this run',
    loaded: 'Loaded',
    openedInTab: 'Opened in tab',
    error: 'Error',
    retry: 'Retry',
    saveToDisk: 'Save to disk',
    loadFirmware: 'Load',
    downloadAndLoad: 'Download and load into updater',
    show: 'Show:',
    tracker: 'Tracker',
    receiver: 'Receiver',
    all: 'All',
  },

  // ── Firmware card ──────────────────────────────────────
  fw: {
    title: 'Firmware',
    files: 'file(s)',
    dropHere: 'Drag & drop {uf2}, {hex}, or {zip} firmware file(s) here',
    chooseFiles: 'Choose Files',
    addMore: '+ Add More',
    saveToDisk: 'Save to disk',
    remove: 'Remove',
    boardTargetMapping: 'Board Target Mapping',
    allMapped: 'All mapped',
    unmappedTargets: 'Unmapped targets',
    selectFirmware: '— Select firmware —',
    targetExact: 'Firmware target matches the device target.',
    developerBypass: 'Developer mode: target validation bypassed.',
    targetUnknown: 'The filename does not identify a known target. Verify this firmware manually before flashing.',
    modeChange: 'Known mode change: firmware target is {target}. Verify the hardware wiring and sensor bus mode.',
    roleMismatch: 'Blocked: this is {role} firmware, not firmware for this device role.',
    targetMismatch: 'Blocked: firmware target {target} does not match this device target.',
    targetAmbiguous: 'Blocked: the filename matches more than one firmware role.',
  },

  // ── Update card ────────────────────────────────────────
  update: {
    title: 'Update',
    trackersSelected: 'tracker(s) selected',
    trackersFirstThenReceiver: 'Trackers will be updated first, then the receiver.',
    receiverAclBlocked: 'Receiver has nRF5 OpenDFU bootloader — enter DFU mode (double-tap reset), then use Serial DFU below to flash.',
    receiverUnsupported: 'Receiver firmware mapped but self-OTA unsupported — update receiver via UF2/DFU.',
    startUpdate: 'Start Update',
    selectFirmwareFirst: 'Select a firmware file first',
    selectTrackersOrReceiver: 'Select trackers to update or load receiver firmware',
    mapAllTargets: 'Map firmware to all board targets',
    batch: 'Batch',
    abortUpdate: 'Abort Update',
    updateSuccessful: 'Update Successful!',
    allUpdated: 'All trackers have been updated and rebooted.',
    autoDismiss: 'Auto-dismissing in {seconds}s…',
    updateFailed: 'Update Failed',
    checkLog: 'Check the log for details. Failed trackers will reboot to bootloader.',
    scanAgain: 'Scan Again',
    dismiss: 'Dismiss',
    confirmTitle: 'Confirm firmware targets',
    confirmWarning: 'Review every device target and firmware file. Flashing the wrong target can make the device unusable until it is recovered over USB.',
    cancel: 'Cancel',
    confirmFlash: 'Targets are correct — flash',
  },

  // ── Serial DFU card ────────────────────────────────────
  dfu: {
    title: 'Serial DFU',
    usb: 'USB',
    description: 'Flash firmware directly via USB serial — device must be in DFU/bootloader mode (double-tap reset or {cmd} command)',
    webSerialNotSupported: 'Web Serial not supported',
    webSerialRequires: 'This browser does not provide the Web Serial API.',
    protocol: 'Protocol',
    autoDetect: 'Auto-detect',
    adafruit: 'Adafruit (Legacy)',
    nordic: 'Nordic (Secure)',
    firmwareLabel: 'Firmware (ZIP / UF2 / HEX)',
    orUseLoaded: 'Or use loaded firmware:',
    fromOta: 'from OTA',
    clear: 'Clear',
    flashViaSerial: 'Flash via Serial',
    abort: 'Abort',
    dfuComplete: 'DFU Complete!',
    dfuFailed: 'DFU Failed',
    developerModeTitle: 'Developer mode: Serial target verification disabled',
    developerModeDetail: 'The physical target and second typed confirmation will not be requested. The selected firmware will be sent to the chosen serial device.',
    developerBypass: 'Developer mode: role and target checks bypassed.',
    modelRequired: 'Serial DFU cannot verify the device model.',
    modelRequiredDetail: 'Enter the exact target you physically verified on the device. This is the first confirmation; the bootloader does not report a trustworthy model.',
    expectedTarget: 'Physically verified device target',
    expectedTargetPlaceholder: 'for example: promicro_uf2/nrf52840/spi',
    confirmTitle: 'Confirm Serial DFU target again',
    selectRole: 'Role',
    targetExact: 'Firmware role and target match this selection.',
    targetUnknown: 'Filename target is unknown. Continue only after manually verifying the file.',
    modeChange: 'Known mode change from firmware target {target}. Verify wiring and sensor bus mode.',
    roleMismatch: 'Blocked: selected role does not match this {role} firmware.',
    targetMismatch: 'Blocked: firmware target {target} does not match the entered target.',
    targetAmbiguous: 'Blocked: filename matches more than one firmware role.',
    confirmWarning: 'The selected serial port exposes only USB VID/PID and DFU protocol. It does not prove the board model. A wrong image can require USB/SWD recovery.',
    firmware: 'Firmware',
    firmwareTarget: 'Filename target',
    unknownTarget: 'unknown — manually verify the file',
    typeTargetAgain: 'Type {target} again to confirm the physical model is correct.',
    confirmFlash: 'Model confirmed — flash',
    dfuLog: 'DFU Log',
  },

  // ── Log panel ──────────────────────────────────────────
  log: {
    title: 'Log',
    entries: 'entries',
  },

  // ── Footer ─────────────────────────────────────────────
  footer: {
    by: 'by',
    trackerFirmware: 'Tracker Firmware (devc)',
    receiverFirmware: 'Receiver Firmware (devc)',
  },
};
