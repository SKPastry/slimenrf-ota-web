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
    otaRequires: 'OTA 需要使用来自 {tracker} 的兼容追踪器固件和来自 {receiver} 的接收器固件。如需要，请先通过 USB/UF2 刷写。',
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
    trackerCi: '追踪器 CI（所有分支）',
    receiverCi: '接收器 CI（所有分支）',
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
    trackerFirmware: '追踪器固件（devc）',
    receiverFirmware: '接收器固件（devc）',
  },
};
