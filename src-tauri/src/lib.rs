use hidapi::HidApi;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const REPORT_SIZE: usize = 64;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub serial_number: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InputReportEvent {
    pub device_path: String,
    pub report_id: u8,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDisconnectedEvent {
    pub device_path: String,
}

struct OpenDevice {
    device: Arc<Mutex<hidapi::HidDevice>>,
    stop_flag: Arc<AtomicBool>,
    reader_handle: Option<std::thread::JoinHandle<()>>,
}

struct HidState {
    api: HidApi,
    devices: HashMap<String, OpenDevice>,
}

#[tauri::command]
fn hid_list_devices(
    vid: u16,
    pid: u16,
    state: tauri::State<'_, Mutex<HidState>>,
) -> Result<Vec<DeviceInfo>, String> {
    let mut state = state.lock();
    state.api.refresh_devices().map_err(|e| e.to_string())?;

    let devices: Vec<DeviceInfo> = state
        .api
        .device_list()
        .filter(|d| {
            (vid == 0 || d.vendor_id() == vid) && (pid == 0 || d.product_id() == pid)
        })
        .map(|d| DeviceInfo {
            path: d.path().to_string_lossy().into_owned(),
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            product_name: d.product_string().unwrap_or("").to_string(),
            serial_number: d.serial_number().unwrap_or("").to_string(),
        })
        .collect();

    Ok(devices)
}

#[tauri::command]
fn hid_open_device(
    path: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<HidState>>,
) -> Result<DeviceInfo, String> {
    let mut state = state.lock();

    if state.devices.contains_key(&path) {
        return Err("Device already open".into());
    }

    let c_path = std::ffi::CString::new(path.clone()).map_err(|e| e.to_string())?;
    let device = state.api.open_path(&c_path).map_err(|e| e.to_string())?;

    let info_list: Vec<_> = state
        .api
        .device_list()
        .filter(|d| d.path().to_string_lossy() == path)
        .collect();

    let info = info_list.first().ok_or("Device not found in list")?;
    let device_info = DeviceInfo {
        path: path.clone(),
        vendor_id: info.vendor_id(),
        product_id: info.product_id(),
        product_name: info.product_string().unwrap_or("").to_string(),
        serial_number: info.serial_number().unwrap_or("").to_string(),
    };

    device
        .set_blocking_mode(false)
        .map_err(|e| e.to_string())?;

    let device = Arc::new(Mutex::new(device));
    let stop_flag = Arc::new(AtomicBool::new(false));

    let reader_device = Arc::clone(&device);
    let reader_stop = Arc::clone(&stop_flag);
    let reader_path = path.clone();
    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; REPORT_SIZE + 1];
        let mut consecutive_errors = 0u32;
        while !reader_stop.load(Ordering::Relaxed) {
            let dev = reader_device.lock();
            match dev.read_timeout(&mut buf, 5) {
                Ok(0) => {
                    drop(dev);
                    consecutive_errors = 0;
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Ok(n) => {
                    // hidapi read does NOT prepend report ID for report-ID-0 devices.
                    // SlimeNRF uses report ID 0, so buf[0..n] is pure data.
                    let data = buf[..n].to_vec();
                    drop(dev);
                    consecutive_errors = 0;
                    let event = InputReportEvent {
                        device_path: reader_path.clone(),
                        report_id: 0,
                        data,
                    };
                    let _ = app.emit("hid-input-report", &event);
                }
                Err(_) => {
                    drop(dev);
                    consecutive_errors += 1;
                    // After many consecutive errors, device is likely disconnected
                    if consecutive_errors > 20 {
                        let _ = app.emit(
                            "hid-device-disconnected",
                            &DeviceDisconnectedEvent {
                                device_path: reader_path.clone(),
                            },
                        );
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }
    });

    state.devices.insert(
        path,
        OpenDevice {
            device,
            stop_flag,
            reader_handle: Some(reader_handle),
        },
    );

    Ok(device_info)
}

#[tauri::command]
fn hid_close_device(path: String, state: tauri::State<'_, Mutex<HidState>>) -> Result<(), String> {
    let mut open_dev = {
        let mut state = state.lock();
        state.devices.remove(&path).ok_or("Device not open")?
    };
    // Mutex released before join to avoid blocking other commands
    open_dev.stop_flag.store(true, Ordering::Relaxed);
    if let Some(handle) = open_dev.reader_handle.take() {
        let _ = handle.join();
    }
    Ok(())
}

#[tauri::command]
fn hid_write(
    path: String,
    report_id: Option<u8>,
    data: Vec<u8>,
    state: tauri::State<'_, Mutex<HidState>>,
) -> Result<usize, String> {
    let state = state.lock();

    let open_dev = state.devices.get(&path).ok_or("Device not open")?;

    // hidapi write: first byte is report ID
    let mut report = Vec::with_capacity(1 + data.len());
    report.push(report_id.unwrap_or(0x00));
    report.extend_from_slice(&data);

    let device = open_dev.device.lock();
    device.write(&report).map_err(|e| e.to_string())
}

// ── Serial port commands ────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub path: String,
    pub port_type: String,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    pub product_name: Option<String>,
    pub serial_number: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialDataEvent {
    pub port_path: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialDisconnectedEvent {
    pub port_path: String,
}

struct OpenSerialPort {
    port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    stop_flag: Arc<AtomicBool>,
    reader_handle: Option<std::thread::JoinHandle<()>>,
}

struct SerialState {
    ports: HashMap<String, OpenSerialPort>,
}

#[tauri::command]
fn serial_list_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;

    Ok(ports
        .into_iter()
        .map(|p| {
            let (port_type, vid, pid, product, serial) = match &p.port_type {
                serialport::SerialPortType::UsbPort(usb) => (
                    "usb".to_string(),
                    Some(usb.vid),
                    Some(usb.pid),
                    usb.product.clone(),
                    usb.serial_number.clone(),
                ),
                serialport::SerialPortType::BluetoothPort => {
                    ("bluetooth".to_string(), None, None, None, None)
                }
                serialport::SerialPortType::PciPort => {
                    ("pci".to_string(), None, None, None, None)
                }
                serialport::SerialPortType::Unknown => {
                    ("unknown".to_string(), None, None, None, None)
                }
            };
            SerialPortInfo {
                path: p.port_name,
                port_type,
                vendor_id: vid,
                product_id: pid,
                product_name: product,
                serial_number: serial,
            }
        })
        .collect())
}

#[tauri::command]
fn serial_open(
    path: String,
    baud_rate: u32,
    app: AppHandle,
    state: tauri::State<'_, Mutex<SerialState>>,
) -> Result<(), String> {
    let mut state = state.lock();

    if state.ports.contains_key(&path) {
        return Err("Port already open".into());
    }

    let port = serialport::new(&path, baud_rate)
        .data_bits(serialport::DataBits::Eight)
        .stop_bits(serialport::StopBits::One)
        .parity(serialport::Parity::None)
        .flow_control(serialport::FlowControl::None)
        .timeout(std::time::Duration::from_millis(10))
        .open()
        .map_err(|e| e.to_string())?;

    let port = Arc::new(Mutex::new(port));
    let stop_flag = Arc::new(AtomicBool::new(false));

    let reader_port = Arc::clone(&port);
    let reader_stop = Arc::clone(&stop_flag);
    let reader_path = path.clone();
    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut consecutive_errors = 0u32;
        while !reader_stop.load(Ordering::Relaxed) {
            let mut p = reader_port.lock();
            match p.read(&mut buf) {
                Ok(0) => {
                    drop(p);
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    drop(p);
                    consecutive_errors = 0;
                    let _ = app.emit(
                        "serial-data",
                        &SerialDataEvent {
                            port_path: reader_path.clone(),
                            data,
                        },
                    );
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    drop(p);
                    consecutive_errors = 0;
                    // Timeout is normal in non-blocking mode
                }
                Err(_) => {
                    drop(p);
                    consecutive_errors += 1;
                    if consecutive_errors > 20 {
                        let _ = app.emit(
                            "serial-disconnected",
                            &SerialDisconnectedEvent {
                                port_path: reader_path.clone(),
                            },
                        );
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }
    });

    state.ports.insert(
        path,
        OpenSerialPort {
            port,
            stop_flag,
            reader_handle: Some(reader_handle),
        },
    );

    Ok(())
}

#[tauri::command]
fn serial_write(
    path: String,
    data: Vec<u8>,
    state: tauri::State<'_, Mutex<SerialState>>,
) -> Result<usize, String> {
    let state = state.lock();
    let open_port = state.ports.get(&path).ok_or("Port not open")?;
    let mut port = open_port.port.lock();
    port.write(&data).map_err(|e| e.to_string())
}

#[tauri::command]
fn serial_close(
    path: String,
    state: tauri::State<'_, Mutex<SerialState>>,
) -> Result<(), String> {
    let mut open_port = {
        let mut state = state.lock();
        state.ports.remove(&path).ok_or("Port not open")?
    };
    // Mutex released before join to avoid blocking other commands
    open_port.stop_flag.store(true, Ordering::Relaxed);
    if let Some(handle) = open_port.reader_handle.take() {
        let _ = handle.join();
    }
    Ok(())
}

#[tauri::command]
fn serial_set_signals(
    path: String,
    dtr: Option<bool>,
    rts: Option<bool>,
    state: tauri::State<'_, Mutex<SerialState>>,
) -> Result<(), String> {
    let state = state.lock();
    let open_port = state.ports.get(&path).ok_or("Port not open")?;
    let mut port = open_port.port.lock();

    if let Some(dtr_val) = dtr {
        port.write_data_terminal_ready(dtr_val)
            .map_err(|e| e.to_string())?;
    }
    if let Some(rts_val) = rts {
        port.write_request_to_send(rts_val)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let api = HidApi::new().expect("Failed to initialize HidApi");

    tauri::Builder::default()
        .manage(Mutex::new(HidState {
            api,
            devices: HashMap::new(),
        }))
        .manage(Mutex::new(SerialState {
            ports: HashMap::new(),
        }))
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hid_list_devices,
            hid_open_device,
            hid_close_device,
            hid_write,
            serial_list_ports,
            serial_open,
            serial_write,
            serial_close,
            serial_set_signals,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
