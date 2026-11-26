import sys

import pyarrow as pa
from deepnote_toolkit.artifacts import store_dataframe

frame_file, name = sys.argv[1:]
store_dataframe(pa.ipc.open_file(frame_file).read_all().to_pandas(), name)
