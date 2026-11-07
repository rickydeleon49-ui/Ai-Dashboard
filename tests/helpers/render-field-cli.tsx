/**
 * Renders Field samples to static markup in a child process (the unit suite's
 * react-server condition blocks react-dom/server). Writes { key: html } to stdout.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, Select } from "../../src/components/ui/field";

const out = {
  select: renderToStaticMarkup(
    <Field label="Project" help="Pick one">
      <Select>
        <option>a</option>
      </Select>
    </Field>,
  ),
  ownId: renderToStaticMarkup(
    <Field label="Name">
      <input id="mine" />
    </Field>,
  ),
  group: renderToStaticMarkup(
    <Field label="Many">
      <input />
      <input />
    </Field>,
  ),
};
process.stdout.write(JSON.stringify(out));
