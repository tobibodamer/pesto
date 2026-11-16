"""Packs the front hemisphere of the SADIE II KU100 HRIRs into public/hrir/ku100.bin.

    python -I dev/hrir.py path/to/D1_48K_24bit_256tap_FIR_SOFA.sofa

Source: https://sofacoustics.org/data/database/sadie/ (University of York, Apache 2.0).
Layout: int16 little-endian, for each elevation in ELS, for each azimuth in AZS
(degrees, positive = listener's right), 256 samples left ear then 256 right ear.
src/voice/hrir.ts reads it with the same constants.
"""
import site, sys
site.addsitedir(site.getusersitepackages())
import h5py
import numpy as np

ELS = [-30, -15, 0, 15, 30]
AZS = list(range(-90, 91, 3))

f = h5py.File(sys.argv[1], "r")
pos = f["SourcePosition"][:]
ir = f["Data.IR"][:]
assert int(f["Data.SamplingRate"][0]) == 48000 and ir.shape[2] == 256

out = np.zeros((len(ELS), len(AZS), 2, 256), dtype=np.float64)
for i, el in enumerate(ELS):
    for j, az in enumerate(AZS):
        sofa_az = (-az) % 360  # SOFA counts azimuth anticlockwise
        hit = np.where((np.abs(pos[:, 1] - el) < 0.1) & (np.abs(pos[:, 0] - sofa_az) < 0.1))[0]
        assert len(hit) == 1, (el, az)
        out[i, j] = ir[hit[0]]

peak = np.abs(out).max()
packed = np.round(out / peak * 32767).astype("<i2")
open("public/hrir/ku100.bin", "wb").write(packed.tobytes())
print(f"{packed.size * 2} bytes, peak {peak:.3f}, {len(ELS)}x{len(AZS)} directions")
