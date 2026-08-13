import { Hono } from 'hono'
import { notificationsListHandler } from './list'
import { notificationReadHandler } from './read'
import { notificationsReadAllHandler } from './read-all'

const notificationsRouter = new Hono()

notificationsRouter.get('/', notificationsListHandler)
notificationsRouter.post('/:id/read', notificationReadHandler)
notificationsRouter.post('/read-all', notificationsReadAllHandler)

export { notificationsRouter }
