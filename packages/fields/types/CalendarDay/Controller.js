import FieldController from '../../Controller';

export default class CalendarDayController extends FieldController {
  getFilterGraphQL = ({ type, value }) => {
    const key = type === 'is' ? `${this.path}` : `${this.path}_${type}`;
    return `${key}: "${value}"`;
  };
  getFilterLabel = ({ label }) => {
    return `${this.label} ${label.toLowerCase()}`;
  };
  formatFilter = ({ label, value }) => {
    return `${this.getFilterLabel({ label })}: "${value}"`;
  };
  getValue = data => {
    return data[this.config.path];
  };
  filterTypes = [
    {
      type: 'is',
      label: 'Is exactly',
      getInitialValue: () => '',
    },
    {
      type: 'not',
      label: 'Is not exactly',
      getInitialValue: () => '',
    },
    {
      type: 'gt',
      label: 'Is greater than',
      getInitialValue: () => '',
    },
    {
      type: 'lt',
      label: 'Is less than',
      getInitialValue: () => '',
    },
    {
      type: 'gte',
      label: 'Is greater than or equal to',
      getInitialValue: () => '',
    },
    {
      type: 'lte',
      label: 'Is less than or equal to',
      getInitialValue: () => '',
    },
    // QUESTION: should we support "in" and "not_in" filters for birthday?
    // What does the UI look like for that.
  ];
}