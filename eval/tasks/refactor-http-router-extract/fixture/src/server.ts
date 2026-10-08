export interface Request {
	method: string;
	path: string;
}

export interface Response {
	status: number;
	body: string;
}

const users = [
	{ id: "1", name: "ada" },
	{ id: "42", name: "grace" },
];

function listUsers(): Response {
	return { status: 200, body: JSON.stringify(users) };
}

function getUser(id: string): Response {
	const user = users.find((u) => u.id === id);
	if (!user) {
		return { status: 404, body: "user not found" };
	}
	return { status: 200, body: JSON.stringify(user) };
}

function health(): Response {
	return { status: 200, body: "ok" };
}

const notFound: Response = { status: 404, body: "not found" };
const methodNotAllowed: Response = { status: 405, body: "method not allowed" };

export function handle(req: Request): Response {
	const { method, path } = req;
	if (path === "/health") {
		if (method !== "GET") {
			return methodNotAllowed;
		}
		return health();
	}
	if (path === "/users") {
		if (method !== "GET") {
			return methodNotAllowed;
		}
		return listUsers();
	}
	if (path.startsWith("/users/")) {
		const id = path.slice("/users/".length);
		if (id === "" || id.includes("/")) {
			return notFound;
		}
		if (method !== "GET") {
			return methodNotAllowed;
		}
		return getUser(id);
	}
	return notFound;
}
