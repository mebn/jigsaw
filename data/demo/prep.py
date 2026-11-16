# Encodes each picture as the new jigsaw page would: full image, 480px thumbnail, 1200x630 preview.
import json, math, os, sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
# file, pieces, state, progress (0..1)
PLAN = [
  ('hands.jpg', 500, 'fresh', 0),
  ('11b20654b1035ff5eb394b58a67c10fe.jpg', 210, 'done', 1),
  ('6685268c9b8446005d54d15159719513.jpg', 300, 'done', 1),
  ('af4d6b8a238207e098f9f7537af1ba96.jpg', 400, 'done', 1),
  ('9fbaef14cf67d71e04179c2148809cb0.jpg', 500, 'done', 1),
  ('49bd1a19eb034a310b5499165f2662e4.jpg', 750, 'done', 1),
  ('24e6dd2803bbf756ec1c806a40bb07e6.jpg', 1000, 'progress', 0.65),
  ('a038512d26fd1c097dd962b2a54b7ed3.jpg', 1500, 'progress', 0.35),
  ('5ca4ecaeeabc1123d800cd50a2404bdd.jpg', 600, 'progress', 0.85),
  ('a683ce6760cf73e1ca9b718ae17889f9.jpg', 250, 'done', 1),
  ('28ab188f96f90ede29dba366212607ac.jpg', 350, 'done', 1),
  ('charlota_blunarova.jpg', 1200, 'done', 1),
  ('hannes_richter_1024.jpg', 800, 'done', 1),
  ('micha_frank.jpg', 1500, 'done', 1),
]
def grid_for(count, w, h):  # gridFor() in src/lib/geometry.ts
    cols = max(2, round(math.sqrt(count * w / h)))
    return cols, max(2, round(count / cols))
def encode(im, side, q, path):
    k = min(1, side / max(im.size))
    sm = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS) if k < 1 else im
    sm.save(path, 'JPEG', quality=q)
    return sm.size
man = []
for n, (f, count, state, prog) in enumerate(PLAN):
    im = Image.open(os.path.join(src, f)).convert('RGB')
    cols, rows = grid_for(count, *im.size)
    base = os.path.join(out, str(n))
    w, h = encode(im, min(4000, max(2400, max(cols, rows) * 55)), 90, base + '-full.jpg')
    encode(im, 480, 80, base + '-thumb.jpg')
    k = min(im.width / 1200, im.height / 630); sw, sh = 1200 * k, 630 * k
    im.crop(((im.width - sw) / 2, (im.height - sh) / 2, (im.width + sw) / 2, (im.height + sh) / 2)).resize((1200, 630), Image.LANCZOS).save(base + '-preview.jpg', 'JPEG', quality=85)
    man.append(dict(file=f, base=base, cols=cols, rows=rows, width=w, height=h, state=state, progress=prog))
    print(f, cols, rows, cols * rows, w, h)
json.dump(man, open(os.path.join(out, 'manifest.json'), 'w'), indent=1)
