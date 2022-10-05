import { TransformPipe } from '@discord-nestjs/common';
import {
  DiscordTransformedCommand,
  On,
  Param,
  Payload,
  TransformedCommandExecutionContext,
  UsePipes,
} from '@discord-nestjs/core';
import { reportException } from '@lib/sentry/reporting';
import {
  ActionRowBuilder,
  AutocompleteInteraction,
  EmbedBuilder,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { CommandHandler, DiscordCommandClass } from '../discord.decorator';
import { IntegrationData, IntegrationDataService } from '../services/integration-data';
import { MyRedirectDataService } from '../services/my-redirect-data';

class MyDto {
  @Param({
    name: 'redirect',
    description: 'What is the name of the redirect?',
    required: true,
    autocomplete: true,
  })
  redirect: string;
}

@DiscordCommandClass({
  name: 'my',
  description: 'Returns a my link',
})
@UsePipes(TransformPipe)
export class MyCommand implements DiscordTransformedCommand<MyDto> {
  constructor(
    private integrationDataService: IntegrationDataService,
    private myRedirectDataService: MyRedirectDataService,
  ) {}

  @CommandHandler()
  async handler(
    @Payload() handlerDto: MyDto,
    context: TransformedCommandExecutionContext,
  ): Promise<void> {
    const { redirect } = handlerDto;
    const { interaction } = context;
    if (redirect === 'reload') {
      await this.myRedirectDataService.ensureData(true);

      await interaction.reply({
        content: 'My redirect list reloaded',
        ephemeral: true,
      });
      return;
    }

    const redirectData = await this.myRedirectDataService.getRedirect(redirect);

    if (!redirectData) {
      await interaction.reply({
        content: 'Could not find information',
        ephemeral: true,
      });
      return;
    }

    if (redirectData.params) {
      await interaction.showModal(
        new ModalBuilder({
          title: 'Additional data',
          customId: redirectData.redirect,
          components: Object.entries(redirectData.params).map(([key, keyType]) =>
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
              new TextInputBuilder({
                custom_id: key,
                label: key,
                required: !keyType.includes('?'),
                style: TextInputStyle.Short,
              }),
            ),
          ),
        }),
      );
      return;
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder({
          title: redirectData.name,
          description: redirectData.description,
          url: `https://my.home-assistant.io/create-link/?redirect=${redirectData.redirect}`,
        }),
      ],
    });
  }

  @On('interactionCreate')
  async onInteractionCreate(
    interaction: AutocompleteInteraction | ModalSubmitInteraction,
  ): Promise<void> {
    // This is the autocomplete handler for the /my command
    if (interaction.isAutocomplete() && interaction.commandName === 'my') {
      try {
        await this.myRedirectDataService.ensureData();
        const focusedValue = interaction.options.getFocused()?.toLowerCase();

        await interaction.respond(
          focusedValue.length !== 0
            ? this.myRedirectDataService.data
                .filter((redirect) => !redirect.deprecated)
                .map((redirect) => ({
                  name: redirect.name,
                  value: redirect.redirect,
                }))
                .filter(
                  (choice) =>
                    choice.value.toLowerCase().includes(focusedValue) ||
                    choice.name.toLowerCase().includes(focusedValue),
                )
                // The API only allow max 25 sugestions
                .slice(0, 25)
            : [],
        );
      } catch (err) {
        reportException(err, {
          cause: err,
          data: {
            interaction: interaction.toJSON(),
            user: interaction.user.toJSON(),
            channel: interaction.channel.toJSON(),
            command: interaction.command.toJSON(),
          },
        });
        await interaction.respond([]);
      }
    } // This is modal submition handler if the redirect supports params
    else if (interaction.isModalSubmit()) {
      const redirectData = await this.myRedirectDataService.getRedirect(interaction.customId);
      const domainField = interaction.fields.fields.get('domain');
      let integrationData: IntegrationData;

      if (domainField) {
        integrationData = await this.integrationDataService.getIntegration(domainField.value);
      }

      const url = new URL(`https://my.home-assistant.io/redirect/${redirectData.redirect}/`);
      for (const field of interaction.fields.fields.values()) {
        url.searchParams.set(field.customId, field.value);
      }
      await interaction.reply({
        embeds: [
          new EmbedBuilder({
            title:
              domainField && redirectData.redirect === 'config_flow_start'
                ? `Add integration: ${integrationData?.title || domainField}`
                : redirectData.name,
            description: redirectData.description,
            url: url.toString(),
          }),
        ],
      });
    }
  }
}