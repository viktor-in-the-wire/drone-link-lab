import struct
import binascii
import hmac
import hashlib
import time
import os
import socket
from dotenv import load_dotenv
load_dotenv()

# Controller / Ground Station
GROUND = ("127.0.0.1", 14550)

# Constants
sys_id = 1              # this drone's id
STX = 0xFD              # start marker
seq = 0                 # seq counter
INCOMPAT_FLAG = 0x01    # when the frame is signed
COMPAT_FLAG = 0x00      # flags the receiver may ignore
COMP_ID = 1             # which component sent the frame 

# Drone Status
ARMED = 1 << 0              # 00000001
GPS_LOCK = 1 << 1           # 00000010
LOW_BATTERY = 1 << 2        # 00000100
RETURNING = 1 << 3          # 00001000
FAILSAFE = 1 << 4           # 00010000
FLIGHT_MODE = 0b111 << 5    # 11100000
MODE_SHIFT = 5
# Flight Modes
MANUAL = 1
STABILIZE = 2
AUTO = 3
LOITER = 4
status = 0             # reset status

# Set status on drone
status = status | ARMED | GPS_LOCK
status = status | (AUTO << MODE_SHIFT)

# Messages
MSGID = 42000           # check 6. Messages for all types of messages

# Signing
LINK_ID = 0             # which connection the frame travels on
try:
    KEY = (os.getenv("KEY")).encode()
    print(len(KEY))  # secret key for signature
except Exception as e:
    raise Exception(f"[-] Key not found inside .env file!\n{e}")
# Build payload and then send it to build_packet()
def build_payload(t=123456, alt=12050, spd=450, bat=87, sat=9, status=status):
    data = struct.pack(">IiHBBB", t, alt, spd, bat, sat, status)
    return data

# Build packet and then send it to sign_packet()
def build_packet(payload, stx=STX, incompat_flag=INCOMPAT_FLAG, compat_flag=COMPAT_FLAG, sys_id=sys_id, comp_id=COMP_ID, msg_id=MSGID):
    global seq
    msg_id_hi = (msg_id >> 8) & 0xFFFF
    msg_id_lo = msg_id & 0xFF
    header = struct.pack("<BBBBBBBH", len(payload), incompat_flag, compat_flag, 
                         seq % 256, sys_id, comp_id, msg_id_lo, msg_id_hi)
    seq += 1
    crc = binascii.crc_hqx(header + payload, 0xFFFF)
    return bytes([stx]) + header + payload + struct.pack(">H", crc)

# Sign frame and send signed frame to ground station
def sign_frame(key, frame, link_id) -> bytes:
    timestamp = int((time.time() - 1_420_070_400) * 100_000)
    data = frame + struct.pack("<BQ", link_id, timestamp)[:7]

    signature = hmac.new(key, data, hashlib.sha256).digest()[:6]
    return data + signature

# helper function that connects all three stages in one
def frame_build():
    payload = build_payload()
    packet = build_packet(payload)
    frame = sign_frame(KEY, packet, LINK_ID)
    return frame

# help function that sends the frame and uses try/except to handle errors
def send_frame(frame, drone):
    try:
        drone.sendto(frame, GROUND)
        print(f"[+] Frame sent to ground station!")
    except Exception as e:
        print(f"\n[-] There was an error sending the frame: \n      {e}\n")

def main():
    for _ in range(2):
        drone = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        frame = frame_build()
        send_frame(frame, drone)
if __name__ == "__main__":
    main()