import struct
import socket
import os
import hmac
import hashlib
import binascii
from dotenv import load_dotenv
load_dotenv()

# Ground station port
GROUND = ("127.0.0.1", 14550)
TIMEOUT = 5

# Drone Status
ARMED = 1 << 0              # 00000001
GPS_LOCK = 1 << 1           # 00000010
LOW_BATTERY = 1 << 2        # 00000100
RETURNING = 1 << 3          # 00001000
FAILSAFE = 1 << 4           # 00010000
FLIGHT_MODE = 0b111 << 5    # 11100000
MODE_SHIFT = 5
# Flight Modes
MODES = {"MANUAL": 1, "STABILIZE": 2, "AUTO": 3, "LOITER": 4}

# Constants that increment over time
seq = 0
first_seq = True
MSG_ID = {0: "HEARTBEAT", 42000: "DRONE_TELEMETRY", 42001: "DRONE_COMMAND", 42002: "DRONE_ACK"}
try:
    KEY = (os.getenv("KEY")).encode()  # secret key for signature
except Exception as e:
    raise Exception(f"[-] Key not found inside .env file!\n{e}")
TIMESTAMP = 0
first_timestamp = True

class FrameError(Exception):
    pass

# Check if frame is valid and then return the bytes for header, payload and signature block
def parse_frame(frame):
    # a frame can be minimum 12 bytes only when the payload is empty
    if len(frame) < 25 or len(frame) > 280:
        raise FrameError(f"[-] Invalid frame length... Length: [{len(frame)}] | Expected: [25-280]") 
    if frame[0] != 0xFD:
        raise FrameError(f"[-] Frame doesn't have the correct STX marker")
    header = frame[1:10]
    length = frame[1]
    payload = frame[10:10+length]
    if len(frame) < 25 + length:
        raise FrameError("[-] Invalid frame length")

    # get CRC
    recv_crc = struct.unpack(">H", frame[10+length:10+length+2])[0]

    if binascii.crc_hqx(frame[1:10+length], 0xFFFF) == recv_crc:
        return header, payload
    raise FrameError(f"[-] Checksum not valid!")

# parse header
def parse_header(header):
    length, incompat_flag, compat_flag, sequence, sys_id, compid, msg_id_lo, msg_id_hi = struct.unpack("<BBBBBBBH", header)
    msgid = (msg_id_hi << 8) | msg_id_lo
    if incompat_flag != 0x01:
        raise FrameError("[-] Unsupported flag")
    if msgid not in MSG_ID:
        raise FrameError("[-] Unknown MSG_ID")
    return length, sys_id, msgid, sequence

# validate signature
def validate_signature(key, frame, sequence):
    global seq, first_seq
    signature = frame[-6:]
    frame_no_s = frame[:-6]

    sig = hmac.new(key, frame_no_s, hashlib.sha256).digest()[:6]
    if not hmac.compare_digest(sig, signature):
        return False
    if first_seq:
        seq = sequence
        first_seq = False
        return True
    elif seq + 1 != sequence:
        raise FrameError(f"[-] Sequence is not valid")
        return False
    seq = sequence
    return True

# parse payload
def parse_payload(payload, msgid):
    if msgid == 42000:
        t, alt, spd, bat, sat, st = struct.unpack(">IiHBBB", payload)
        FLAGS = {"ARMED": bool(st & ARMED), "GPS_LOCK": bool(st & GPS_LOCK),
                "LOW_BATTERY": bool(st & LOW_BATTERY), "RETURNING": bool(st & RETURNING),
                "FAILSAFE": bool(st & FAILSAFE)}
        filtered = {flags: "ON" for flags, status in FLAGS.items() if status}
        flags_str = " ".join(f"{k}={v}" for k, v in filtered.items()) if filtered else "none"
        read_status = (st >> 5) & 0b111
        for name, status in MODES.items():
            if status == read_status:
                mode = name
        return t, alt, spd, bat, sat, flags_str, mode
    else:
        raise FrameError(f"[-] Unknown MSG_ID")
# helpfer function that handles errors when receiving frames
def recv_frame(ground):
    try:
        frame, sender = ground.recvfrom(1024)
        header, payload = parse_frame(frame)
        length, sys_id, msgid, sequence = parse_header(header)
        if not validate_signature(KEY, frame, sequence):
            raise FrameError("[-] Signature invalid")
        
        return payload, length, sys_id, msgid
    except Exception as e:
        raise FrameError(f"     [-] There was a problem receiving the frame from drone:\n{e}\n")

def main():    
    ground = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ground.bind(GROUND)
    ground.settimeout(TIMEOUT)
    for _ in range(2):
        payload, length, sys_id, msgid = recv_frame(ground)
        t, alt, spd, bat, sat, flags_str, mode = parse_payload(payload, msgid)
        with open("connection.log", "a") as f:
            f.write(f"[{seq}] Drone ID: [{sys_id}] | MSG_ID [{msgid}]\n[+] Telemetry: t={t / 1000}s "
                    f"alt={alt / 100}m speed={spd / 100}m/s battery={bat}% sats={sat}\n"
                    f"    mode={mode}  flags={flags_str or 'none'}\n\n")
        print(f"[+] Frame received from Drone [{sys_id}]")

if __name__ == "__main__":
    main()