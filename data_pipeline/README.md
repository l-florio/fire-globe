# FIRMS global pipeline

Download, normalizzazione e aggregazione degli hotspot NASA FIRMS (MODIS e VIIRS), su scala globale.

SI disclosure: lo script è stato generato con assistenza di Claude (Anthropic). Va dichiarato nella submission e nei metadati del repo.

## Dati

| Dataset | Fonte | Periodo | Accesso | Volume |
|---|---|---|---|---|
| MODIS (Terra+Aqua), Standard Processing | zip annuali FIRMS per paese | 2000-2025 | libero | circa 2 GB zip, circa 9 GB CSV |
| VIIRS S-NPP 375 m, SP | zip annuali FIRMS per paese | 2012-2025 | libero | circa 5 GB zip, circa 21 GB CSV |
| VIIRS NOAA-20 (opzionale, `--sensors ...,VIIRS_NOAA20`) | zip annuali FIRMS | 2018-2025 (da verificare) | libero | circa 330 MB zip/anno |
| Anno corrente (SP, poi NRT) | API area FIRMS, `world`, finestre di 5 giorni | dal 1/1 a oggi | MAP_KEY gratuita | circa 65 chiamate per sensore |

Note sui dati:
- Gli zip contengono un CSV per paese, quindi i rilevamenti fuori dai confini nazionali potrebbero mancare (da verificare se serve).
- L'API restituisce dati senza paese; i dati NRT non hanno il campo `type`, che negli aggregati vale -1.
- Quota MAP_KEY: una chiamata mondiale VIIRS su 5 giorni costa 180 transazioni, una MODIS 45. Lo script controlla `mapkey_status` e attende il reset se la quota è esaurita.

## Installazione

```bash
py -3.12 -m venv .venv
```
```bash
.venv\Scripts\python -m pip install -r requirements.txt
```

## Uso

Test veloce, solo Italia, pochi MB:
```bash
.venv\Scripts\python firms_pipeline.py --years 2012-2025 sample-country --country Italy
```

Pipeline completa (archivio, anno corrente se c'è la chiave, build, aggregazione):
```bash
set FIRMS_MAP_KEY=la_tua_chiave
```
```bash
.venv\Scripts\python firms_pipeline.py all
```

In alternativa alla variabile d'ambiente, la chiave si può mettere in un file `.firms_key` accanto allo script: deve contenere solo la chiave ed è escluso da git.

Singoli passi: `download-archive`, `download-recent`, `build`, `aggregate`.

Opzioni globali, da mettere prima del sottocomando:
- `--sensors MODIS,VIIRS_SNPP`
- `--years 2012-2025`
- `--data <cartella>`
- `--ca-bundle <pem>`

Esempio di aggiornamento periodico, per esempio da GitHub Actions: `download-recent --refresh-days 7`, poi `build`, poi `aggregate`. Le finestre NRT degli ultimi N giorni vengono riscaricate perché i dati NRT si completano col tempo.

## Output (`data/`)

- `raw/archive/*.zip`, `raw/api/<SOURCE>/*.csv`: dati grezzi. Il download riprende da dove si era interrotto.
- `parquet/sensor=<S>/year=<Y>/*.parquet`: schema normalizzato. Colonne:
  - identificazione: `sensor`, `source` (SP_ARCHIVE|SP_API|NRT_API), `country`;
  - posizione e tempo: `latitude`, `longitude`, `acq_date`, `acq_time`, `satellite`;
  - confidenza: `confidence_raw`, `confidence_class` (low/nominal/high);
  - misure: `bright_main`, `bright_aux`, `frp`, `scan`, `track`;
  - altro: `daynight`, `type`, `version`.
- `agg/grid_<res>deg_month.parquet`: celle (default 0,25°) x mese x sensore x type x giorno/notte x confidenza, con `n`, `frp_sum`, `frp_max`.
- `agg/country_month.parquet|csv`: paese x mese x sensore x type x confidenza.
- `agg/metadata.json`: copertura per sensore e sorgente, data di generazione.

Regola SP contro NRT: in aggregazione i dati NRT vengono usati solo dopo l'ultima data Standard Processing dello stesso sensore.

**Nessuna armonizzazione MODIS/VIIRS è applicata agli aggregati**: restano separati per sensore. La serie armonizzata (metodo congelato il 14/11/2026) è prodotta a parte da `harmonize.py` in `data/harmonized/`; vedi `HARMONIZATION.md`.

## Tempi e spazio (stime)

- Download: circa 7 GB; misurati circa 3 MB/s su questa rete, quindi circa 40 minuti.
- Build: circa 7 secondi per un anno MODIS (1,8 milioni di righe), misurato; per VIIRS stimati circa 1-2 minuti l'anno. Servono circa 2 GB temporanei per l'estrazione di ogni zip.
- Spazio totale stimato: zip circa 7 GB + Parquet circa 3-5 GB.

## Test eseguiti (13/11/2026)

- `sample-country` Italy 2025 MODIS + VIIRS: ok (3,1 MB scaricati invece di circa 390 MB).
- `download-archive` MODIS 2000-2001: ok; il rilancio salta i file già presenti.
- `build` + `aggregate` su MODIS 2000-2001 (2,03 milioni di righe) e su CSV sintetici in formato API (SP e NRT): ok. Lo scarto dei dati NRT già coperti da SP è verificato.
- **Non testati**: `download-recent` con MAP_KEY reale (formato di `data_availability` e `mapkey_status` dedotto dalla documentazione) e build completa VIIRS.
