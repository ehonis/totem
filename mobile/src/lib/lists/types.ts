export interface ListItem {
  id: string
  listId: string
  text: string
  checked: boolean
  position: number
  createdAt: string
  updatedAt: string
}

export interface LinkedListTodo {
  id: string
  title: string
  status: 'todo' | 'doing' | 'done'
  dueDate: string | null
  completedAt: string | null
}

export interface TotemList {
  id: string
  title: string
  position: number
  createdAt: string
  updatedAt: string
  itemCount: number
  checkedCount: number
  items: ListItem[]
  linkedTodos: LinkedListTodo[]
}
