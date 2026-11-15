"""Write src/app/locales/<lang>.json from the translation cache made by i18n_translate.py.

Only translations whose English source still matches the current text are written; missing keys fall back to
English in the app.

Steps (from globe_kit/):
  node scripts/i18n_extract.mjs src/app/i18n.ts <tmp>/dict.json
  python scripts/i18n_translate.py <tmp>/dict.json <tmp>/cache.json es,fr,pt,de,ru,zh,id   (local Ollama model)
  python scripts/i18n_write.py <tmp>/dict.json <tmp>/cache.json src/app/locales
"""
import json
import sys
from pathlib import Path

dict_path, cache_path, out_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3])
en = json.load(open(dict_path, encoding='utf-8'))['en']
cache = json.load(open(cache_path, encoding='utf-8'))
out_dir.mkdir(parents=True, exist_ok=True)
for lang, entries in sorted(cache.items()):
    d = {k: entries[k]['tr'] for k in en if k in entries and entries[k]['src'] == en[k]}
    (out_dir / f'{lang}.json').write_text(json.dumps(d, ensure_ascii=False, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    print(f'{lang}: {len(d)}/{len(en)} keys')
