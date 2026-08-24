// 简体中文翻译
export default {
  // ── 应用标题 ──────────────────────────────────────────
  title: 'SlimeNRF OTA 更新工具',

  // ── WebHID 不支持 ─────────────────────────────────────
  webhid: {
    notSupported: '不支持 WebHID',
    useChrome: '请使用 {chrome}、{edge} 或 {opera} 来使用 WebHID。',
  },

  // ── 连接卡片 ──────────────────────────────────────────
  conn: {
    title: '连接',
    rescan: '重新扫描',
    disconnect: '断开连接',
    addDevice: '添加设备',
    pairedDevices: '已配对设备：',
    switchReceiver: '切换接收器（已配对 {count} 个）',
    trackers: '个追踪器',
  },

  // ── OTA 提示 ──────────────────────────────────────────
  notice: {
    otaRequires: 'OTA 需要接收器和追踪器{both}运行 {link} 或更新版本的固件。如需要，请先通过 USB/UF2 刷写。',
    both: '都',
  },

  // ── 接收器卡片 ─────────────────────────────────────────
  receiver: {
    title: '接收器',
    selfOtaUnsupported: '不支持自我OTA',
    noResponse: '无响应',
    noResponseHint: '尝试刷新 — 固件过旧时需 UF2/DFU 刷写',
    querying: '查询中…',
    enterDfu: '进入 DFU',
    enterDfuTitle: '通过串口发送 DFU 命令进入引导程序模式',
    refresh: '刷新',
  },

  // ── 追踪器卡片 ─────────────────────────────────────────
  tracker: {
    title: '追踪器',
    online: '在线',
    offline: '离线',
    selectAll: '全选',
    deselect: '取消选择',
    refreshInfo: '刷新信息',
    otaUnsupported: '不支持OTA',
    flashFirst: '请先通过 UF2/DFU 刷写',
    scanning: '正在扫描追踪器…',
  },

  // ── GitHub 下载 ───────────────────────────────────────
  gh: {
    title: '从 GitHub 下载固件',
    releases: '发布版本',
    trackerCi: '追踪器 CI',
    receiverCi: '接收器 CI',
    onlyMatched: '仅匹配',
    selectCiBuild: '— 选择 CI 构建 —',
    selectReceiverCiBuild: '— 选择接收器 CI 构建 —',
    artifactsShown: '个构件显示',
    firmwaresShown: '个固件显示',
    opensInTab: '将在新标签页打开（拖拽 .zip 文件加载）',
    releasesOpensInTab: '将在新标签页打开',
    loadingArtifacts: '正在加载构件…',
    noReleases: '未找到发布版本',
    noCiBuilds: '未找到追踪器 CI 构建',
    noReceiverCiBuilds: '未找到接收器 CI 构建',
    noArtifacts: '该构建没有找到构件',
    loaded: '已加载',
    openedInTab: '已在新标签页打开',
    error: '错误',
    retry: '重试',
    saveToDisk: '保存到磁盘',
    loadFirmware: '加载',
    downloadAndLoad: '下载并加载到更新器',
    show: '显示：',
    tracker: '追踪器',
    receiver: '接收器',
    all: '全部',
  },

  // ── 固件卡片 ──────────────────────────────────────────
  fw: {
    title: '固件',
    files: '个文件',
    dropHere: '拖拽 {uf2}、{hex} 或 {zip} 固件文件到此处',
    chooseFiles: '选择文件',
    addMore: '+ 添加更多',
    saveToDisk: '保存到磁盘',
    remove: '移除',
    boardTargetMapping: '板级目标映射',
    allMapped: '全部已映射',
    unmappedTargets: '存在未映射目标',
    selectFirmware: '— 选择固件 —',
    targetExact: '固件 target 与设备 target 完全匹配。',
    targetUnknown: '文件名无法识别已知 target。刷写前必须手动确认该固件。',
    modeChange: '检测到已知模式变更：固件 target 为 {target}。请确认硬件接线和传感器总线模式。',
    roleMismatch: '已阻止：这是{role}固件，不属于该设备角色。',
    targetMismatch: '已阻止：固件 target {target} 与设备 target 不匹配。',
    targetAmbiguous: '已阻止：文件名同时匹配多个固件角色。',
  },

  // ── 更新卡片 ──────────────────────────────────────────
  update: {
    title: '更新',
    trackersSelected: '个追踪器已选择',
    trackersFirstThenReceiver: '将先更新追踪器，然后更新接收器。',
    receiverAclBlocked: '接收器使用 nRF5 OpenDFU 引导程序 — 请进入 DFU 模式（双击重置），然后使用下方的串口 DFU 刷写。',
    receiverUnsupported: '接收器固件已映射但不支持自我OTA — 请通过 UF2/DFU 更新接收器。',
    startUpdate: '开始更新',
    selectFirmwareFirst: '请先选择固件文件',
    selectTrackersOrReceiver: '请选择要更新的追踪器或加载接收器固件',
    mapAllTargets: '请将固件映射到所有板级目标',
    batch: '批次',
    abortUpdate: '中止更新',
    updateSuccessful: '更新成功！',
    allUpdated: '所有追踪器已更新并重启。',
    autoDismiss: '{seconds}秒后自动关闭…',
    updateFailed: '更新失败',
    checkLog: '请查看日志了解详情。失败的追踪器将重启到引导程序。',
    scanAgain: '重新扫描',
    dismiss: '关闭',
    confirmTitle: '确认固件目标',
    confirmWarning: '请逐项核对设备 target 与固件文件。错误 target 可能导致设备必须通过 USB 恢复。',
    cancel: '取消',
    confirmFlash: 'target 正确，开始刷写',
  },

  // ── 串口 DFU 卡片 ─────────────────────────────────────
  dfu: {
    title: '串口 DFU',
    usb: 'USB',
    description: '通过 USB 串口直接刷写固件 — 设备须处于 DFU/引导程序模式（双击重置或输入 {cmd} 命令）',
    webSerialNotSupported: '不支持 Web Serial',
    webSerialRequires: 'Web Serial API 需要 Chrome 89+、Edge 89+ 或 Opera 76+。',
    protocol: '协议',
    autoDetect: '自动检测',
    adafruit: 'Adafruit（传统）',
    nordic: 'Nordic（安全）',
    firmwareLabel: '固件（ZIP / UF2 / HEX）',
    orUseLoaded: '或使用已加载的固件：',
    fromOta: '来自OTA',
    clear: '清除',
    flashViaSerial: '通过串口刷写',
    abort: '中止',
    dfuComplete: 'DFU 完成！',
    dfuFailed: 'DFU 失败',
    modelRequired: '串口 DFU 无法验证设备型号。',
    modelRequiredDetail: '请输入您在设备实物上核对的完整 target。这是第一次确认；当前引导程序不会报告可信型号。',
    expectedTarget: '实物核对后的设备 target',
    expectedTargetPlaceholder: '例如：promicro_uf2/nrf52840/spi',
    confirmTitle: '再次确认串口 DFU target',
    selectRole: '角色',
    targetExact: '固件角色和 target 与当前选择匹配。',
    targetUnknown: '无法从文件名识别 target。仅在手动核对文件后继续。',
    modeChange: '检测到固件 target {target} 的已知模式变更。请确认接线和传感器总线模式。',
    roleMismatch: '已阻止：所选角色与该{role}固件不匹配。',
    targetMismatch: '已阻止：固件 target {target} 与输入的 target 不匹配。',
    targetAmbiguous: '已阻止：文件名同时匹配多个固件角色。',
    confirmWarning: '所选串口只能提供 USB VID/PID 和 DFU 协议，不能证明板型。错误镜像可能需要通过 USB/SWD 恢复。',
    firmware: '固件',
    firmwareTarget: '文件名 target',
    unknownTarget: '未知——必须手动核对文件',
    typeTargetAgain: '再次输入 {target}，确认设备实物型号正确。',
    confirmFlash: '型号已确认，开始刷写',
    dfuLog: 'DFU 日志',
  },

  // ── 日志面板 ──────────────────────────────────────────
  log: {
    title: '日志',
    entries: '条',
  },

  // ── 页脚 ──────────────────────────────────────────────
  footer: {
    by: '作者',
    trackerFirmware: '追踪器固件',
    receiverFirmware: '接收器固件',
  },
};
