interface EnvironmentSnapshot {
  readonly present: boolean;
  readonly value?: string;
}

export class OwnedEnvironmentValue {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #name: string;
  readonly #baseline: EnvironmentSnapshot;
  #ownedValue?: string;

  constructor(name: string, environment: NodeJS.ProcessEnv = process.env) {
    this.#name = name;
    this.#environment = environment;
    this.#baseline = {
      present: Object.hasOwn(environment, name),
      value: environment[name],
    };
  }

  set(value: string): void {
    this.#environment[this.#name] = value;
    this.#ownedValue = value;
  }

  restore(): void {
    if (this.#ownedValue === undefined || this.#environment[this.#name] !== this.#ownedValue) return;
    if (this.#baseline.present) this.#environment[this.#name] = this.#baseline.value;
    else delete this.#environment[this.#name];
    this.#ownedValue = undefined;
  }
}
