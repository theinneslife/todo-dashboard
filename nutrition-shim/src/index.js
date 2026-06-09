export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('ok', { status: 200 });

    const body = await request.json();

    // Health Auto Export sends the full history:
    //   { "data": { "metrics": [ { name, units, data: [ { date, qty }, ... ] }, ... ] } }
    // We only want TODAY: the most recent data point for each metric.
    const metrics = body?.data?.metrics ?? [];

    let latestDate = null;
    const data = [];

    // ── Sleep stage helpers ────────────────────────────────────────────────────
    // When HAE "Summarize Data" is OFF, Apple Health delivers one record per
    // sleep stage (AsleepCore / AsleepDeep / AsleepREM / AsleepUnspecified /
    // Awake / InBed) as separate entries in the metric's data array, each with
    // a `value` field naming the stage.  Taking only the LAST entry returns a
    // single stage's duration (~minutes), not a full night.  We must sum all
    // asleep-type stage records to get true sleep time.
    function normVal(v) {
      return String(v ?? '').toLowerCase().replace(/[\s_-]/g, '');
    }
    // stage value strings → bucket. Apple Health exports the asleep substages
    // under BOTH the "Asleep…" prefixed names AND the bare "Core/Deep/REM"
    // names depending on HAE/iOS version — count all of them as asleep. "Awake"
    // and "InBed" are NOT asleep and must be excluded.
    const ASLEEP_STAGE_VALUES = new Set([
      'asleepcore', 'asleepdeep', 'asleeprem',
      'asleepunspecified', 'asleep', 'sleeping',
      'core', 'deep', 'rem',
    ]);
    const INBED_STAGE_VALUES = new Set(['inbed', 'inbedunspecified']);
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

    // metric names (normalised) that represent sleep
    function normName(n) {
      return String(n ?? '').toLowerCase().replace(/[\s_-]/g, '');
    }
    const SLEEP_METRIC_NAMES = new Set([
      'sleepanalysis', 'sleep', 'sleeping', 'timeasleep',
      'totalsleep', 'sleepdurationasleep', 'asleepunspecified', 'asleep',
    ]);

    for (const metric of metrics) {
      const points = metric?.data;
      if (!Array.isArray(points) || points.length === 0) continue;

      const mName = normName(metric.name);

      // ── Sleep metrics: aggregate a FULL night ──────────────────────────────
      // HAE delivers sleep in three shapes; the old code only handled the first
      // and silently fell back to "last data point" for the others — which is a
      // single ~minutes-long sleep fragment, not a night (the cause of the
      // 0.04–0.83h values the dashboard was showing). Handle all three, and
      // scope aggregation to the LATEST night so a multi-day payload doesn't
      // sum several nights together.
      //   (1) Per-stage records (Summarize OFF, legacy): each point has a
      //       `value` naming the stage ("Core"/"Deep"/"REM"/"Awake"/"InBed"/
      //       "Asleep"/"AsleepCore"…) and `qty` = that segment's duration.
      //   (2) Per-night records (Summarize OFF, modern): each point has numeric
      //       `asleep`/`core`/`deep`/`rem`/`inBed` keys and no `value`.
      //   (3) Single daily total (Summarize ON): one point with `qty`.
      if (SLEEP_METRIC_NAMES.has(mName)) {
        const dayOf = (p) => (typeof p?.date === 'string' ? p.date.slice(0, 10) : null);
        // HAE timestamps look like "2026-06-08 07:00:00 +0000"; normalise to an
        // ISO string Date.parse understands. Returns NaN on failure.
        const tsOf = (p) => {
          if (typeof p?.date !== 'string') return NaN;
          return Date.parse(p.date.replace(' ', 'T').replace(' ', ''));
        };

        // Restrict to the most recent night. A single night's per-stage records
        // straddle midnight (some on the prior calendar date), so scope by a
        // rolling 18h window before the latest timestamp rather than an exact
        // calendar date — that keeps one straddling night whole while still
        // separating distinct nights (~24h apart) in a multi-day payload.
        const WINDOW_MS = 18 * 3600 * 1000;
        let latestTs = -Infinity;
        for (const p of points) { const t = tsOf(p); if (!isNaN(t) && t > latestTs) latestTs = t; }

        let night = null;
        let nightPts;
        if (latestTs > -Infinity) {
          nightPts = points.filter(p => { const t = tsOf(p); return !isNaN(t) && t >= latestTs - WINDOW_MS; });
          night = dayOf(nightPts.reduce((a, b) => (tsOf(b) > tsOf(a) ? b : a)));
        } else {
          // No parseable timestamps — fall back to exact-calendar-date scoping.
          for (const p of points) { const d = dayOf(p); if (d && (night === null || d > night)) night = d; }
          nightPts = night ? points.filter(p => dayOf(p) === night) : points;
        }

        let asleepQty = 0;
        let inBedQty  = 0;

        for (const pt of nightPts) {
          if (!pt || typeof pt !== 'object') continue;

          // Shape (1): a labelled segment.
          if (pt.value != null && pt.qty != null) {
            const stage = normVal(pt.value);
            if (ASLEEP_STAGE_VALUES.has(stage))      asleepQty += num(pt.qty);
            else if (INBED_STAGE_VALUES.has(stage))  inBedQty  += num(pt.qty);
            continue;
          }

          // Shape (2): numeric stage keys on the record. Prefer an explicit
          // `asleep` total; otherwise sum the asleep substages (NOT awake).
          const stageSum = num(pt.core) + num(pt.deep) + num(pt.rem)
                         + num(pt.asleepCore) + num(pt.asleepDeep) + num(pt.asleepREM)
                         + num(pt.asleepUnspecified);
          if (pt.asleep != null)   asleepQty += num(pt.asleep);
          else if (stageSum > 0)   asleepQty += stageSum;
          if (pt.inBed != null)    inBedQty  += num(pt.inBed);
        }

        // Shape (3): nothing stage-like found, but a plain qty exists → that IS
        // the daily total (Summarize ON).
        if (asleepQty === 0 && inBedQty === 0) {
          const last = nightPts[nightPts.length - 1];
          if (last && last.qty != null) asleepQty = num(last.qty);
        }

        if (asleepQty > 0) {
          data.push({ name: metric.name, qty: asleepQty, unit: metric.units ?? null });
        }
        if (inBedQty > 0) {
          // Python recognises "Time in Bed" → timeinbed → SLEEP_INBED
          data.push({ name: 'Time in Bed', qty: inBedQty, unit: metric.units ?? null });
        }
        if (night && (latestDate === null || night > latestDate)) latestDate = night;

        console.log(`Sleep parsed (night=${night}): asleep=${asleepQty} inBed=${inBedQty} `
          + `unit=${metric.units} records=${nightPts.length} sample0=${JSON.stringify(nightPts[0])}`);
        continue;
      }

      // ── All other metrics (and sleep with Summarize ON) ────────────────────
      // HAE appends chronologically, so the last entry is the most recent.
      // Some Apple Health metrics (notably HRV) can have a trailing sentinel
      // record with qty == null or qty == "". Walk backwards to find the last
      // record that carries an actual numeric value so we never silently drop
      // a metric just because its final point has no qty.
      let last = null;
      for (let i = points.length - 1; i >= 0; i--) {
        const p = points[i];
        if (p != null && p.qty != null && p.qty !== '') {
          last = p;
          break;
        }
      }

      // Debug log for HRV so we can verify it's flowing through
      if (mName.includes('heartratevariability') || mName.includes('hrv')) {
        console.log(`HRV metric: name=${metric.name} norm=${mName} points=${points.length} `
          + `lastFound=${last ? JSON.stringify(last) : 'null'} `
          + `rawLast=${JSON.stringify(points[points.length - 1])}`);
      }

      if (last == null) continue;

      data.push({
        name: metric.name,
        qty: last.qty,
        unit: metric.units ?? null
      });

      // Track the newest date seen (format: "YYYY-MM-DD HH:mm:ss +0000").
      const day = typeof last.date === 'string' ? last.date.slice(0, 10) : null;
      if (day && (latestDate === null || day > latestDate)) latestDate = day;
    }

    const clientPayload = { date: latestDate, data };

    const serialized = JSON.stringify({ event_type: 'nutrition-sync', client_payload: clientPayload });
    console.log(`Trimmed payload: ${data.length} metrics, ${serialized.length} bytes, date=${latestDate}`);

    const resp = await fetch('https://api.github.com/repos/theinneslife/todo-dashboard/dispatches', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'nutrition-shim'
      },
      body: serialized
    });

    return new Response(
      resp.status === 204 ? 'ok' : await resp.text(),
      { status: resp.status === 204 ? 200 : resp.status }
    );
  }
};
