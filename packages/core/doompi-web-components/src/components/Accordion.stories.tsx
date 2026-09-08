/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * Both accordions carry a default value so the open panel paints without a
 * click: the renderer screenshots the first frame.
 */
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './Accordion.tsx';

const meta = {
  title: 'Components/Accordion',
  component: Accordion,
  tags: ['style-system'],
};

export default meta;

const SHELL = 'w-96 rounded-md border border-doom-border bg-doom-panel px-3';

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">type single</span>
        <Accordion type="single" defaultValue="a" collapsible className={SHELL}>
          <AccordionItem value="a">
            <AccordionTrigger>request headers</AccordionTrigger>
            <AccordionContent>
              Only one item stays open. The chevron rotates from the trigger&apos;s open state.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="b">
            <AccordionTrigger>response body</AccordionTrigger>
            <AccordionContent>Collapsed until its trigger is pressed.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="c">
            <AccordionTrigger>timing</AccordionTrigger>
            <AccordionContent>The last item drops its bottom rule.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">type multiple</span>
        <Accordion type="multiple" defaultValue={['a', 'c']} className={SHELL}>
          <AccordionItem value="a">
            <AccordionTrigger>tool calls</AccordionTrigger>
            <AccordionContent>Any number of items may be open at once.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="b">
            <AccordionTrigger>diagnostics</AccordionTrigger>
            <AccordionContent>Closed.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="c">
            <AccordionTrigger>usage</AccordionTrigger>
            <AccordionContent>Open alongside the first item.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  ),
};
