"""Translate the app's UI strings with the local Ollama model, validate them, cache them.

Usage: python i18n_translate.py dict.json cache.json es,fr,pt,de,ru,zh,id,ja,ar,hi,ko,tr [--limit N]
(see i18n_write.py for the full procedure; needs a local Ollama with the model below)
The cache maps lang -> key -> {"src": english text, "tr": translation}; a key is re-translated only when
its English text changed. Invalid outputs (placeholders, tags, month list, script) are retried one by one
and left out if still invalid (the app then falls back to English for that key).
"""
import json, re, sys, time, urllib.request

MODEL = 'qwen3.5:9b-q4_K_M'
NAMES = {
    'es': 'Spanish (neutral, for Spain and Latin America)', 'fr': 'French', 'pt': 'Brazilian Portuguese',
    'de': 'German', 'ru': 'Russian', 'zh': 'Simplified Chinese', 'id': 'Indonesian', 'ja': 'Japanese',
    'ar': 'Modern Standard Arabic', 'hi': 'Hindi (Devanagari script)', 'ko': 'Korean', 'tr': 'Turkish',
    'el': 'Greek', 'pl': 'Polish', 'nb': 'Norwegian Bokmal', 'sv': 'Swedish', 'fi': 'Finnish', 'sq': 'Albanian',
    'nl': 'Dutch', 'sw': 'Swahili', 'vi': 'Vietnamese', 'th': 'Thai', 'bn': 'Bengali', 'fa': 'Persian (Farsi)',
    'ur': 'Urdu',
}
BATCH = 20
PH = re.compile(r'\{\w+\}')
TAG = re.compile(r'</?[a-zA-Z][^>]*>|&[a-z#0-9]+;')
CJK = re.compile(r'[぀-ヿ一-鿿]')
CYR = re.compile(r'[Ѐ-ӿ]')
# Expected script per language (a translation of a real sentence must contain it)
SCRIPT = {'zh': CJK, 'ja': CJK, 'ru': CYR, 'ar': re.compile(r'[؀-ۿ]'),
          'hi': re.compile(r'[ऀ-ॿ]'), 'el': re.compile(r'[Ͱ-Ͽ]'),
          'fa': re.compile(r'[؀-ۿ]'), 'ur': re.compile(r'[؀-ۿ]'), 'th': re.compile(r'[฀-๿]'),
          'bn': re.compile(r'[ঀ-৿]'), 'ko': re.compile(r'[가-힯]')}
# Names that must survive translation unchanged whenever the English text contains them
KEEP = ['Fire Globe', 'NASA', 'FIRMS', 'MODIS', 'VIIRS', 'GFED', 'S-NPP', 'NOAA-20', 'NOAA-21', 'GIBS', 'Esri',
        'OpenStreetMap', 'Nominatim', 'DuckDB', 'CesiumJS', 'CSV', 'PNG', 'SQL']
LATIN = {'en', 'it', 'es', 'fr', 'pt', 'de', 'id', 'tr', 'pl', 'nb', 'sv', 'fi', 'sq', 'nl', 'sw', 'vi'}

SYSTEM = """You translate the user interface of a scientific web app ("Fire Globe") that shows NASA satellite active-fire detections (MODIS and VIIRS hotspots) on a 3D globe, with tables, charts and a calendar.
Rules:
- Return ONLY a JSON object with exactly the same keys as the input and the translated strings as values.
- Keep every {placeholder} exactly as written (same name, same braces), and keep HTML tags and entities unchanged.
- Do not translate: product and sensor names (Fire Globe, NASA, FIRMS, MODIS, VIIRS, Terra, Aqua, S-NPP, NOAA-20, NOAA-21, GIBS, GFED, Esri, OpenStreetMap, Nominatim, Natural Earth, CesiumJS, DuckDB), file formats (CSV, PNG, MP4, WebM, JSON, Parquet), SQL keywords and code in backticks, units (km, km2, MW, deg).
- Abbreviations: FRP stays FRP. Month abbreviations must follow the target language.
- Short, natural UI wording, same tone and punctuation style as the source; keep sentence-final punctuation as in the source.
- A list separated by commas must stay a list with the same number of items.
- The Italian version is given only as a hint to disambiguate; translate from English."""


def ollama(messages, timeout=600):
    body = json.dumps({'model': MODEL, 'messages': messages, 'stream': False, 'think': False, 'format': 'json',
                       'options': {'temperature': 0.2, 'num_ctx': 8192}}).encode()
    req = urllib.request.Request('http://localhost:11434/api/chat', body, {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())['message']['content']


def valid(lang, key, src, tr):
    if not isinstance(tr, str) or not tr.strip():
        return 'empty'
    if sorted(PH.findall(src)) != sorted(PH.findall(tr)):
        return 'placeholders'
    if sorted(TAG.findall(src)) != sorted(TAG.findall(tr)):
        return 'tags'
    if any(w in src and w not in tr for w in KEEP):
        return 'name'
    if src.count(',') >= 5 and len(src.split(',')) != len(tr.split(',')) and key.endswith('months'):
        return 'list'
    base = PH.sub('', src)
    for w in KEEP + ['Terra', 'Aqua', 'Blue Marble', 'Black Marble', 'World Imagery']:
        base = base.replace(w, '')
    letters = len(re.findall(r'[A-Za-z]', base))  # words that should be translated
    if lang in SCRIPT and letters > 6 and not SCRIPT[lang].search(tr):
        return 'script'
    if lang in LATIN and re.search(r'[Ͱ-ϿЀ-ӿ؀-ۿऀ-ॿঀ-৿฀-๿぀-ヿ一-鿿가-힯]', tr):
        return 'script'
    if lang not in ('zh', 'ja') and CJK.search(tr):
        return 'script'
    if len(tr) > 4 * len(src) + 40:
        return 'length'
    return None


def translate(lang, items, it):
    payload = {k: v for k, v in items}
    hint = {k: it[k] for k, _ in items if k in it}
    msgs = [{'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': f'Target language: {NAMES[lang]}.\nItalian hint: {json.dumps(hint, ensure_ascii=False)}\n'
                                        f'Translate these English strings:\n{json.dumps(payload, ensure_ascii=False)}'}]
    try:
        out = json.loads(ollama(msgs))
    except Exception as e:  # malformed JSON or timeout
        print('  batch error:', e)
        return {}
    return out if isinstance(out, dict) else {}


def main():
    dict_path, cache_path, langs = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
    d = json.load(open(dict_path, encoding='utf-8'))
    en, it = d['en'], d['it']
    try:
        cache = json.load(open(cache_path, encoding='utf-8'))
    except FileNotFoundError:
        cache = {}
    for lang in langs:
        c = cache.setdefault(lang, {})
        for k in [k for k, e in c.items() if k in en and e.get('src') == en[k] and valid(lang, k, en[k], e.get('tr'))]:
            del c[k]  # cached but invalid under the current rules: translate again
        todo = [(k, v) for k, v in en.items() if c.get(k, {}).get('src') != v]
        if limit:
            todo = todo[:limit]
        print(f'{lang}: {len(todo)} to translate', flush=True)
        t0 = time.time()
        bad = []
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            out = translate(lang, chunk, it)
            for k, v in chunk:
                why = valid(lang, k, v, out.get(k))
                if why:
                    bad.append((k, v))
                else:
                    c[k] = {'src': v, 'tr': out[k]}
            json.dump(cache, open(cache_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
            print(f'  {min(i + BATCH, len(todo))}/{len(todo)}  {time.time() - t0:.0f}s', flush=True)
        failed = []
        for k, v in bad:  # one by one, two attempts
            for _ in range(2):
                out = translate(lang, [(k, v)], it)
                why = valid(lang, k, v, out.get(k))
                if not why:
                    c[k] = {'src': v, 'tr': out[k]}
                    break
            else:
                failed.append((k, why))
        json.dump(cache, open(cache_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
        print(f'{lang}: done in {time.time() - t0:.0f}s, retried {len(bad)}, failed {len(failed)}: {failed[:10]}', flush=True)


if __name__ == '__main__':
    main()
