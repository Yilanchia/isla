import { FileArchive, formatVitals, measureLife } from "@isla/life";

/**
 * How a life has been going, week by week, read off its archive:
 *
 *   node dist/vitals.js path/to/isla.life.jsonl
 *
 * diary / notes: share of what she wrote that week that she had never written before.
 * belief: beliefs about herself formed or changed. firsts: things met for the first time.
 * unmet+fine: nights she had wanted company for three days or more and still felt fine.
 */
const path = process.argv[2];
if (!path) {
  console.error("usage: node dist/vitals.js <life.jsonl>");
  process.exit(1);
}
const events = await new FileArchive(path).load();
console.log(`${events.length} events`);
console.log(formatVitals(measureLife(events)));
