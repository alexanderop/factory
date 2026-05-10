<script setup lang="ts">
import { computed, ref } from 'vue';
import { applyInitialColorMode, COLOR_MODE_STORAGE_KEY, toggleColorMode } from './colorMode.ts';

applyInitialColorMode({
	prefersDark: () =>
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-color-scheme: dark)').matches,
	getStored: () => {
		const value = localStorage.getItem(COLOR_MODE_STORAGE_KEY);
		return value === 'dark' || value === 'light' ? value : null;
	},
});

type Todo = {
	id: number;
	text: string;
	done: boolean;
};

function onToggleTheme() {
	toggleColorMode({
		setStored: (mode) => localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode),
	});
}

const todos = ref<Todo[]>([
	{ id: 1, text: 'Try Nuxt UI', done: true },
	{ id: 2, text: 'Build a to-do list', done: false },
	{ id: 3, text: 'Add dark mode', done: false },
]);

const draft = ref('');
const filter = ref<'all' | 'active' | 'done'>('all');

const filtered = computed(() => {
	if (filter.value === 'active') return todos.value.filter((t) => !t.done);
	if (filter.value === 'done') return todos.value.filter((t) => t.done);
	return todos.value;
});

const remaining = computed(() => todos.value.filter((t) => !t.done).length);

let nextId = todos.value.reduce((max, t) => Math.max(max, t.id), 0) + 1;

function addTodo() {
	const text = draft.value.trim();
	if (text === '') return;
	todos.value.push({ id: nextId++, text, done: false });
	draft.value = '';
}

function toggle(todo: Todo) {
	todo.done = !todo.done;
}

function remove(todo: Todo) {
	todos.value = todos.value.filter((t) => t.id !== todo.id);
}

function clearCompleted() {
	todos.value = todos.value.filter((t) => !t.done);
}
</script>

<template>
	<UApp>
		<main class="min-h-screen bg-muted py-12 px-4">
			<div class="mx-auto max-w-xl">
				<header class="mb-6 flex items-start justify-between gap-3">
					<div>
						<h1 class="text-3xl font-semibold text-highlighted">To-do</h1>
						<p class="text-muted mt-1">
							{{ remaining }} {{ remaining === 1 ? 'task' : 'tasks' }} left
						</p>
					</div>
					<UButton
						icon="i-lucide-sun-moon"
						variant="ghost"
						color="neutral"
						size="md"
						aria-label="Toggle theme"
						@click="onToggleTheme"
					/>
				</header>

				<UCard>
					<form class="flex gap-2" @submit.prevent="addTodo">
						<UInput
							v-model="draft"
							placeholder="What needs to be done?"
							icon="i-lucide-plus"
							class="flex-1"
							size="lg"
						/>
						<UButton type="submit" size="lg" :disabled="draft.trim() === ''"> Add </UButton>
					</form>

					<div class="mt-4 flex gap-2">
						<UButton
							v-for="option in ['all', 'active', 'done'] as const"
							:key="option"
							:variant="filter === option ? 'solid' : 'soft'"
							color="neutral"
							size="sm"
							@click="filter = option"
						>
							{{ option }}
						</UButton>
					</div>

					<ul class="mt-4 divide-y divide-default">
						<li
							v-for="todo in filtered"
							:key="todo.id"
							class="flex items-center gap-3 py-3"
							data-testid="todo-item"
						>
							<UCheckbox :model-value="todo.done" @update:model-value="toggle(todo)" />
							<span
								class="flex-1 text-default"
								:class="{ 'line-through text-dimmed': todo.done }"
								data-testid="todo-text"
							>
								{{ todo.text }}
							</span>
							<UButton
								icon="i-lucide-trash-2"
								color="error"
								variant="ghost"
								size="sm"
								aria-label="Delete"
								@click="remove(todo)"
							/>
						</li>
						<li v-if="filtered.length === 0" class="py-8 text-center text-dimmed">Nothing here.</li>
					</ul>

					<div v-if="todos.some((t) => t.done)" class="mt-4 flex justify-end">
						<UButton variant="ghost" color="neutral" size="sm" @click="clearCompleted">
							Clear completed
						</UButton>
					</div>
				</UCard>
			</div>
		</main>
	</UApp>
</template>
