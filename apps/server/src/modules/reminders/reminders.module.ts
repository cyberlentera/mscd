import { Module } from '@nestjs/common';
import { ReadModelModule } from '../read-model/read-model.module';
import { Br50ReminderThrottle } from './reminder.rules';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';

/** Reminders and bulk reminders with BR-50 throttling (E.5, WP-35). BR-50 is registered here for the `RuleEngine`. */
@Module({
  imports: [ReadModelModule],
  controllers: [RemindersController],
  providers: [RemindersService, Br50ReminderThrottle],
  exports: [RemindersService],
})
export class RemindersModule {}
