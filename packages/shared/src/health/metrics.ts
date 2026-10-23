import { Context, type Effect } from "effect";

// The health plugin accepts the telemetry-owned scrape effect; it must not
// create a second exporter listener or invent metrics when collection fails.
export class MetricsReader extends Context.Service<
  MetricsReader,
  {
    readonly scrape: Effect.Effect<
      { readonly contentType: string; readonly body: string },
      unknown
    >;
  }
>()("krun/MetricsReader") {}
