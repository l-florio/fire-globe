"""Make src/app/locales/en-GB.json from the US English source with a British spelling map (no model).

Usage (from globe_kit/): python scripts/i18n_en_gb.py <dict.json from i18n_extract.mjs> src/app/locales/en-GB.json
Only keys whose text changes are written; the others fall back to the US source. Words in ALL CAPS (file names
such as HARMONIZATION.md), text in backticks and proper names (Apache License) are left alone.
Dates and numbers follow the en-GB locale in the app, so they need nothing here.
"""
import json
import re
import sys

STEMS = {
    'color': 'colour', 'harmoniz': 'harmonis', 'center': 'centre', 'analyz': 'analys', 'gray': 'grey',
    'favorite': 'favourite', 'behavior': 'behaviour', 'normaliz': 'normalis', 'visualiz': 'visualis',
    'customiz': 'customis', 'organiz': 'organis', 'recogniz': 'recognis', 'summariz': 'summaris',
    'optimiz': 'optimis', 'minimiz': 'minimis', 'maximiz': 'maximis', 'neighbor': 'neighbour',
    'standardiz': 'standardis', 'categoriz': 'categoris', 'prioritiz': 'prioritis', 'initializ': 'initialis',
    'synchroniz': 'synchronis', 'utiliz': 'utilis', 'rasteriz': 'rasteris', 'serializ': 'serialis',
}
WORDS = {
    'meter': 'metre', 'meters': 'metres', 'kilometer': 'kilometre', 'kilometers': 'kilometres',
    'license': 'licence', 'licenses': 'licences', 'catalog': 'catalogue', 'catalogs': 'catalogues',
    'labeled': 'labelled', 'labeling': 'labelling', 'canceled': 'cancelled', 'canceling': 'cancelling',
    'modeled': 'modelled', 'modeling': 'modelling', 'traveled': 'travelled', 'fulfill': 'fulfil',
    'gray': 'grey', 'program': 'programme',
}
PROTECT = ['Apache License', 'MIT License', 'Harmonization of MODIS and VIIRS Hot Spots']
WORD = re.compile(r"[A-Za-z]+")


def case_like(src, dst):
    return dst.capitalize() if src[0].isupper() else dst


def fix_word(w):
    if w.isupper() and len(w) > 1:
        return w  # acronyms, file names
    low = w.lower()
    if low in WORDS:
        return case_like(w, WORDS[low])
    for us, gb in STEMS.items():
        if low.startswith(us):
            return case_like(w, gb + low[len(us):])
    return w


def british(text):
    parts = re.split(r'(`[^`]*`|\{\w+\}|' + '|'.join(map(re.escape, PROTECT)) + r')', text)
    out = []
    for i, p in enumerate(parts):
        out.append(p if i % 2 else WORD.sub(lambda m: fix_word(m.group(0)), p))
    return ''.join(out)


en = json.load(open(sys.argv[1], encoding='utf-8'))['en']
gb = {k: british(v) for k, v in en.items() if british(v) != v}
open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps(gb, ensure_ascii=False, indent=1, sort_keys=True) + '\n')
print(f'en-GB: {len(gb)} keys differ from US')
for k in list(gb)[:12]:
    print(' ', k, '|', en[k][:60], '=>', gb[k][:60])
