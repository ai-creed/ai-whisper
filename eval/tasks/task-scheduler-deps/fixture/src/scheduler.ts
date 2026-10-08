export type JobStatus = "done" | "failed";

interface Job {
	name: string;
	run: () => Promise<void>;
}

export class Scheduler {
	private readonly jobs: Job[] = [];

	add(name: string, run: () => Promise<void>): void {
		if (this.jobs.some((job) => job.name === name)) throw new Error(`duplicate job ${name}`);
		this.jobs.push({ name, run });
	}

	async runAll(): Promise<Record<string, JobStatus>> {
		const results: Record<string, JobStatus> = {};
		for (const job of this.jobs) {
			try {
				await job.run();
				results[job.name] = "done";
			} catch {
				results[job.name] = "failed";
			}
		}
		return results;
	}
}
