import { Command } from "commander";

const program = new Command();

program
  .name("ingest")
  .description("Ingest Google Takeout mbox exports into Cloudflare D1 + R2")
  .requiredOption("--account <id>", "Account identifier")
  .requiredOption("--mbox <path>", "Path to .mbox file")
  .option("--dry-run", "Validate without writing to Cloudflare")
  .option("--resume", "Skip already-uploaded message IDs")
  .action((options) => {
    console.log("ingest CLI ready", options);
  });

program.parse();
